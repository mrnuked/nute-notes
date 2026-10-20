package org.nutenotes.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

final class QueueRules {
    static final int MAX_REQUEST = 4 * 1024 * 1024;
    static final int MAX_RESPONSE = 24 * 1024 * 1024;
    static final int MAX_CHECKPOINT = 20 * 1024 * 1024;
    static final int MAX_CACHE = 64 * 1024 * 1024 + 64 * 1024;
    static final int MAX_BACKUP = 64 * 1024 * 1024;
    static final int MAX_BRIDGE = 72 * 1024 * 1024;
    static final long MAX_QUEUE = 64L * 1024 * 1024;
    private static final Pattern UUID = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}");
    static boolean validId(String id) { return id != null && UUID.matcher(id).matches(); }
    static int bytes(String value) { return value.getBytes(StandardCharsets.UTF_8).length; }
    static void require(boolean condition, String message) { if (!condition) throw new IllegalArgumentException(message); }
    static void requestSize(String action, int bytes) { require(bytes >= 0 && bytes <= (action.equals("sync_checkpoint") ? MAX_CHECKPOINT : MAX_REQUEST), "Запрос слишком большой."); }
    static void localSize(String field, int bytes) { require(bytes >= 0 && bytes <= (field.equals("cache") ? MAX_CACHE : MAX_RESPONSE), "Слишком большой локальный снимок."); }
    static JSONArray operations(JSONArray input) throws Exception {
        require(input != null && input.length() <= 1024 && bytes(input.toString()) <= MAX_REQUEST - 32, "Слишком большой пакет изменений.");
        JSONArray clean = new JSONArray(); Set<String> ids = new HashSet<>();
        for (int i = 0; i < input.length(); i++) {
            JSONObject operation = input.getJSONObject(i); String id = operation.getString("id");
            require(validId(id) && ids.add(id) && operation.length() == 2, "Некорректный идентификатор изменения.");
            JSONObject data = operation.getJSONObject("data");
            require(data.length() == 3 && Integer.valueOf(1).equals(data.opt("v")) && data.opt("iv") instanceof String && data.opt("ciphertext") instanceof String, "Некорректное зашифрованное изменение.");
            String iv = data.getString("iv"), ciphertext = data.getString("ciphertext");
            require(ciphertext.length() <= 2800000, "Зашифрованное изменение слишком большое.");
            byte[] rawIv = Base64.getDecoder().decode(iv), raw = Base64.getDecoder().decode(ciphertext);
            require(rawIv.length == 12 && raw.length >= 16 && Base64.getEncoder().encodeToString(rawIv).equals(iv) && Base64.getEncoder().encodeToString(raw).equals(ciphertext), "Некорректные зашифрованные данные.");
            clean.put(new JSONObject().put("id", id).put("data", new JSONObject().put("v", 1).put("iv", iv).put("ciphertext", ciphertext)));
        }
        return clean;
    }
    static Set<String> ids(JSONArray input) throws Exception {
        require(input != null && input.length() <= 10000, "Слишком много подтверждений.");
        Set<String> result = new HashSet<>();
        for (int i = 0; i < input.length(); i++) { String id = input.getString(i); require(validId(id), "Некорректное подтверждение."); result.add(id); }
        return result;
    }
}
