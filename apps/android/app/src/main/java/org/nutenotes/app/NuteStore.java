package org.nutenotes.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Set;

final class NuteStore extends SQLiteOpenHelper {
    private static NuteStore instance;
    private final java.io.File revocationFile;
    static synchronized NuteStore get(Context context) { if (instance == null) instance = new NuteStore(context.getApplicationContext()); return instance; }
    NuteStore(Context context) { super(context, "nute-native.db", null, 1); revocationFile = new java.io.File(context.getFilesDir(), "unlock-revoked"); setWriteAheadLoggingEnabled(true); }
    private boolean unlockRevoked() throws Exception {
        try { java.nio.file.Files.readAttributes(revocationFile.toPath(), java.nio.file.attribute.BasicFileAttributes.class); return true; }
        catch (java.nio.file.NoSuchFileException absent) { return false; }
    }
    private void revokeUnlock() throws Exception {
        // Separate durable barrier, even if deleting the SQLite unlock row fails.
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(revocationFile, true)) { out.getFD().sync(); }
    }
    @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA synchronous=FULL"); db.setForeignKeyConstraintsEnabled(true); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE state (name TEXT PRIMARY KEY, value BLOB NOT NULL)");
        db.execSQL("CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, bytes INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new IllegalStateException("Неподдерживаемая версия хранилища."); }
    private Object value(SQLiteDatabase db, String name) throws Exception {
        int size;
        try (Cursor c = db.rawQuery("SELECT length(value) FROM state WHERE name=?", new String[]{name})) { if (!c.moveToFirst()) return JSONObject.NULL; size = c.getInt(0); }
        QueueRules.require(size > 0 && size <= QueueRules.MAX_CACHE + 64, "Некорректное локальное состояние.");
        // Android CursorWindow is smaller than a large encrypted replica. Read bounded BLOB slices.
        byte[] encrypted = new byte[size];
        for (int offset = 0; offset < size; offset += 1024 * 1024) {
            try (Cursor c = db.rawQuery("SELECT substr(value,?,?) FROM state WHERE name=?", new String[]{String.valueOf(offset + 1), String.valueOf(Math.min(1024 * 1024, size - offset)), name})) {
                if (!c.moveToFirst()) throw new IllegalStateException("Локальное состояние изменилось во время чтения.");
                byte[] part = c.getBlob(0); System.arraycopy(part, 0, encrypted, offset, part.length);
            }
        }
        return new org.json.JSONTokener(SecretBox.open(name, encrypted)).nextValue();
    }
    private void put(SQLiteDatabase db, String name, Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) { db.delete("state", "name=?", new String[]{name}); return; }
        String text = value instanceof String ? JSONObject.quote((String) value) : value.toString(); QueueRules.localSize(name, QueueRules.bytes(text));
        ContentValues row = new ContentValues(); row.put("name", name); row.put("value", SecretBox.seal(name, text));
        if (db.insertWithOnConflict("state", null, row, SQLiteDatabase.CONFLICT_REPLACE) == -1) throw new android.database.SQLException("Не удалось записать локальное состояние.");
    }
    synchronized JSONObject load() throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try { boolean revoked = unlockRevoked(); JSONObject result = new JSONObject().put("cache", value(db, "cache")).put("unlock", revoked ? JSONObject.NULL : value(db, "unlock")).put("lockPending", revoked).put("pending", pending(db, false, 0)).put("lastError", value(db, "lastError")); db.setTransactionSuccessful(); return result; }
        finally { db.endTransaction(); }
    }
    synchronized void save(JSONObject changes) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            for (String field : new String[]{"cache", "unlock"}) if (changes.has(field)) {
                Object next = changes.get(field); QueueRules.require(next == JSONObject.NULL || next instanceof JSONObject, "Некорректное локальное состояние.");
                if (field.equals("cache") && next instanceof JSONObject) {
                    Object previous = value(db, field);
                    if (previous instanceof JSONObject && ((JSONObject) next).optLong("cursor", 0) < ((JSONObject) previous).optLong("cursor", 0)) continue;
                }
                put(db, field, next);
            }
            db.setTransactionSuccessful();
        }
        finally { db.endTransaction(); }
        // Clear the barrier only after a fresh login's unlock is committed.
        if (changes.opt("unlock") instanceof JSONObject) java.nio.file.Files.deleteIfExists(revocationFile.toPath());
    }
    JSONObject credentials() throws Exception { Object result = value(getReadableDatabase(), "credentials"); return result instanceof JSONObject ? (JSONObject) result : new JSONObject().put("cookies", new JSONObject()).put("csrf", ""); }
    void credentials(JSONObject credentials) throws Exception { put(getWritableDatabase(), "credentials", credentials); }
    void lastError(String message) throws Exception { put(getWritableDatabase(), "lastError", message); }
    synchronized void clear(boolean credentials) throws Exception {
        revokeUnlock();
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try { put(db, "unlock", null); if (credentials) put(db, "credentials", null); db.setTransactionSuccessful(); } finally { db.endTransaction(); }
    }
    void enqueue(JSONArray raw) throws Exception {
        JSONArray operations = QueueRules.operations(raw); SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            long bytes; try (Cursor c = db.rawQuery("SELECT COALESCE(SUM(bytes),0) FROM outbox", null)) { c.moveToFirst(); bytes = c.getLong(0); }
            for (int i = 0; i < operations.length(); i++) {
                JSONObject operation = operations.getJSONObject(i); String id = operation.getString("id"), data = operation.getJSONObject("data").toString();
                String previous = outboxData(db, id);
                if (previous != null) { QueueRules.require(previous.equals(data), "Изменение с этим идентификатором уже существует."); continue; }
                int size = QueueRules.bytes(operation.toString()); bytes += size; QueueRules.require(bytes <= QueueRules.MAX_QUEUE, "Локальная очередь заполнена. Откройте приложение с подключением к сети.");
                ContentValues row = new ContentValues(); row.put("id", id); row.put("data", data); row.put("bytes", size); db.insertOrThrow("outbox", null, row);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    private JSONArray pending(SQLiteDatabase db, boolean unsent, int limit) throws Exception {
        JSONArray result = new JSONArray(); int bytes = 32;
        try (Cursor c = db.rawQuery("SELECT id,bytes FROM outbox" + (unsent ? " WHERE delivered=0" : "") + " ORDER BY seq" + (limit > 0 ? " LIMIT " + limit : ""), null)) {
            while (c.moveToNext()) { int size = c.getInt(1) + 1; if (unsent && bytes + size > QueueRules.MAX_REQUEST) break; String data = outboxData(db, c.getString(0)); if (data == null) continue; JSONObject operation = new JSONObject().put("id", c.getString(0)).put("data", new JSONObject(data)); bytes += size; result.put(operation); }
        }
        return result;
    }
    private String outboxData(SQLiteDatabase db, String id) {
        int size;
        try (Cursor c = db.rawQuery("SELECT length(data) FROM outbox WHERE id=?", new String[]{id})) { if (!c.moveToFirst()) return null; size = c.getInt(0); }
        QueueRules.require(size >= 0 && size <= QueueRules.MAX_REQUEST, "Некорректное изменение в очереди.");
        StringBuilder result = new StringBuilder(size);
        for (int offset = 0; offset < size; offset += 1024 * 1024) {
            try (Cursor c = db.rawQuery("SELECT substr(data,?,?) FROM outbox WHERE id=?", new String[]{String.valueOf(offset + 1), String.valueOf(Math.min(1024 * 1024, size - offset)), id})) { if (!c.moveToFirst()) return null; result.append(c.getString(0)); }
        }
        return result.toString();
    }
    JSONArray nextBatch() throws Exception { return pending(getReadableDatabase(), true, 64); }
    void ack(JSONArray ids) throws Exception { updateIds(QueueRules.ids(ids), false); }
    void delivered(JSONArray ids, JSONArray sent) throws Exception {
        Set<String> accepted = QueueRules.ids(ids), allowed = new java.util.HashSet<>();
        for (int i = 0; i < sent.length(); i++) allowed.add(sent.getJSONObject(i).getString("id"));
        QueueRules.require(allowed.containsAll(accepted), "Сервер подтвердил неизвестные изменения."); updateIds(accepted, true);
    }
    private void updateIds(Set<String> ids, boolean delivered) {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try { for (String id : ids) { if (delivered) { ContentValues row = new ContentValues(); row.put("delivered", 1); db.update("outbox", row, "id=?", new String[]{id}); } else db.delete("outbox", "id=?", new String[]{id}); } db.setTransactionSuccessful(); }
        finally { db.endTransaction(); }
    }
}
