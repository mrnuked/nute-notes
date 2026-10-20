package org.nutenotes.app;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class StoreInstrumentedTest {
    @Test public void failedUnlockDeletionCannotReopenButKeepsCacheOutboxAndTrust() throws Exception {
        NuteStore store = NuteStore.get(ApplicationProvider.getApplicationContext());
        String id = java.util.UUID.randomUUID().toString();
        store.save(new JSONObject().put("cache", JSONObject.NULL));
        JSONObject cache = new JSONObject().put("cursor", 7).put("ciphertext", "synthetic-encrypted-cache");
        store.save(new JSONObject().put("cache", cache).put("unlock", new JSONObject().put("secret", "synthetic-unlock")));
        store.enqueue(new JSONArray().put(operation(id)));
        String credentials = store.credentials().toString();
        store.getWritableDatabase().execSQL("CREATE TRIGGER test_reject_unlock BEFORE DELETE ON state WHEN OLD.name='unlock' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END");
        try { assertThrows(Exception.class, () -> store.clear(false)); }
        finally { store.getWritableDatabase().execSQL("DROP TRIGGER test_reject_unlock"); }
        store.close(); JSONObject after = store.load();
        assertTrue(after.isNull("unlock")); assertTrue(after.getBoolean("lockPending"));
        assertEquals(cache.toString(), after.getJSONObject("cache").toString());
        assertTrue(after.getJSONArray("pending").toString().contains(id));
        assertEquals(credentials, store.credentials().toString());
        store.lastError("Synthetic background result"); store.close(); assertTrue(store.load().isNull("unlock"));
        store.clear(false); store.save(new JSONObject().put("unlock", new JSONObject().put("secret", "fresh-login"))); store.close();
        assertEquals("fresh-login", store.load().getJSONObject("unlock").getString("secret"));
        store.clear(false); store.ack(new JSONArray().put(id)); store.save(new JSONObject().put("cache", JSONObject.NULL));
    }
    private JSONObject operation(String id) throws Exception { return new JSONObject().put("id", id).put("data", new JSONObject().put("v", 1).put("iv", "AAECAwQFBgcICQoL").put("ciphertext", "AAECAwQFBgcICQoLDA0ODw==")); }
    @Test public void deliveredJournalSurvivesReopenUntilFrontendCacheAcknowledgement() throws Exception {
        Context context = ApplicationProvider.getApplicationContext(); NuteStore store = NuteStore.get(context);
        String first = java.util.UUID.randomUUID().toString(), second = java.util.UUID.randomUUID().toString();
        JSONArray batch = new JSONArray().put(operation(first)); store.enqueue(batch); store.delivered(new JSONArray().put(first), batch);
        store.enqueue(new JSONArray().put(operation(second))); store.close();
        JSONObject reopened = store.load(); assertTrue(reopened.getJSONArray("pending").toString().contains(first)); assertTrue(reopened.getJSONArray("pending").toString().contains(second));
        assertFalse(store.nextBatch().toString().contains(first)); assertTrue(store.nextBatch().toString().contains(second));
        store.save(new JSONObject().put("cache", new JSONObject().put("testCiphertext", "not-plaintext"))); store.ack(new JSONArray().put(first));
        assertFalse(store.load().getJSONArray("pending").toString().contains(first)); assertTrue(store.load().getJSONArray("pending").toString().contains(second));
        store.clear(true); assertTrue(store.load().getJSONArray("pending").toString().contains(second)); store.ack(new JSONArray().put(second));
    }
    @Test public void keystoreSealingIsRandomizedAndFieldBound() throws Exception {
        byte[] one = SecretBox.seal("unlock", "test-unlock-secret"), two = SecretBox.seal("unlock", "test-unlock-secret");
        assertFalse(java.util.Arrays.equals(one, two)); assertEquals("test-unlock-secret", SecretBox.open("unlock", one));
        assertThrows(Exception.class, () -> SecretBox.open("credentials", one)); one[one.length - 1] ^= 1; assertThrows(Exception.class, () -> SecretBox.open("unlock", one));
    }
    @Test public void lateCacheWriteCannotRegressCursorButUnlockIsStillSaved() throws Exception {
        NuteStore store = NuteStore.get(ApplicationProvider.getApplicationContext());
        store.save(new JSONObject().put("cache", JSONObject.NULL));
        store.save(new JSONObject().put("cache", new JSONObject().put("cursor", 9)));
        store.save(new JSONObject().put("cache", new JSONObject().put("cursor", 8)).put("unlock", new JSONObject().put("wrapped", "opaque-test")));
        JSONObject state = store.load(); assertEquals(9, state.getJSONObject("cache").getLong("cursor")); assertEquals("opaque-test", state.getJSONObject("unlock").getString("wrapped"));
        store.clear(true); store.save(new JSONObject().put("cache", JSONObject.NULL));
    }
    @Test public void encryptedCacheLargerThanAndroidCursorWindowReopens() throws Exception {
        NuteStore store = NuteStore.get(ApplicationProvider.getApplicationContext());
        char[] chars = new char[3 * 1024 * 1024]; java.util.Arrays.fill(chars, 'a'); String large = new String(chars);
        store.save(new JSONObject().put("cache", JSONObject.NULL)); store.save(new JSONObject().put("cache", new JSONObject().put("cursor", 1).put("ciphertext", large))); store.close();
        assertEquals(large, store.load().getJSONObject("cache").getString("ciphertext")); store.save(new JSONObject().put("cache", JSONObject.NULL));
    }
    @Test public void largeCiphertextOperationSurvivesCursorWindowAndDeduplication() throws Exception {
        NuteStore store = NuteStore.get(ApplicationProvider.getApplicationContext()); String id = java.util.UUID.randomUUID().toString();
        JSONObject op = operation(id); op.getJSONObject("data").put("ciphertext", java.util.Base64.getEncoder().encodeToString(new byte[1900000])); JSONArray batch = new JSONArray().put(op);
        store.enqueue(batch); store.enqueue(batch); assertTrue(store.nextBatch().toString().contains(id)); assertTrue(store.load().getJSONArray("pending").toString().contains(id)); store.ack(new JSONArray().put(id));
    }
}
