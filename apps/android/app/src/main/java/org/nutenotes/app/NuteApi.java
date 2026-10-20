package org.nutenotes.app;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpCookie;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.net.HttpURLConnection;

final class NuteApi {
    static final String ORIGIN = BuildConfig.SERVICE_ORIGIN;
    static final Object LOCK = new Object();
    private static final Map<String, String> ACTIONS = actions();
    private static Map<String, String> actions() {
        Map<String, String> result = new java.util.HashMap<>();
        for (String action : new String[]{"bootstrap", "vault", "devices"}) result.put(action, "GET");
        for (String action : new String[]{"email", "login", "setup", "resume", "logout", "revoke_device", "pin_register", "pin_check", "sync_pull", "sync_push", "sync_checkpoint"}) result.put(action, "POST");
        return java.util.Collections.unmodifiableMap(result);
    }
    private final NuteStore store;
    NuteApi(NuteStore store) { this.store = store; }
    JSONObject request(String action, String method, JSONObject data) throws Exception {
        QueueRules.require(method.equals(ACTIONS.get(action)), "Недопустимый запрос приложения.");
        byte[] payload = data.toString().getBytes(StandardCharsets.UTF_8);
        QueueRules.requestSize(action, payload.length);
        synchronized (LOCK) {
            JSONObject credentials = store.credentials();
            JSONObject cookies = credentials.optJSONObject("cookies"); if (cookies == null) cookies = new JSONObject();
            HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + "/api.php?action=" + action).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(25000); connection.setUseCaches(false); connection.setRequestMethod(method);
            connection.setRequestProperty("Origin", ORIGIN); connection.setRequestProperty("X-Nute-Client", "0.4"); connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Cache-Control", "no-store"); connection.setRequestProperty("User-Agent", "NUTE-Android/" + BuildConfig.VERSION_NAME);
            StringBuilder cookieHeader = new StringBuilder(); long now = System.currentTimeMillis();
            for (String name : new String[]{"__Host-nute", "__Host-nute_device"}) {
                JSONObject cookie = cookies.optJSONObject(name);
                if (cookie == null || (cookie.optLong("expires", 0) > 0 && cookie.optLong("expires") <= now)) continue;
                String value = cookie.optString("value", "");
                if (!value.matches("[A-Za-z0-9_.,~%+/:=-]{1,4096}")) continue;
                if (cookieHeader.length() > 0) cookieHeader.append("; "); cookieHeader.append(name).append('=').append(value);
            }
            if (cookieHeader.length() > 0) connection.setRequestProperty("Cookie", cookieHeader.toString());
            if (!method.equals("GET")) {
                connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
                String csrf = credentials.optString("csrf", ""); if (csrf.matches("[A-Za-z0-9_-]{16,256}")) connection.setRequestProperty("X-CSRF-Token", csrf);
                connection.setFixedLengthStreamingMode(payload.length);
            }
            try {
                if (!method.equals("GET")) try (java.io.OutputStream out = connection.getOutputStream()) { out.write(payload); }
                int status = connection.getResponseCode();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Set-Cookie")) continue;
                    for (String line : header.getValue()) for (HttpCookie cookie : HttpCookie.parse(line)) {
                        String name = cookie.getName();
                        if ((!name.equals("__Host-nute") && !name.equals("__Host-nute_device")) || !cookie.getSecure() || cookie.getDomain() != null || !"/".equals(cookie.getPath())) continue;
                        if (cookie.getMaxAge() == 0 || cookie.getValue().isEmpty()) cookies.remove(name);
                        else { long expires = cookie.getMaxAge() < 0 ? 0 : now + Math.min(cookie.getMaxAge(), 366L * 24 * 3600) * 1000; cookies.put(name, new JSONObject().put("value", cookie.getValue()).put("expires", expires)); }
                    }
                }
                JSONObject body;
                InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String text = read(input);
                try { body = new JSONObject(text); } catch (Exception invalid) { body = new JSONObject().put("error", "invalid_response").put("message", "Сервер вернул неподдерживаемый ответ."); }
                credentials.put("cookies", cookies);
                String csrf = body.optString("csrf", ""); if (csrf.matches("[A-Za-z0-9_-]{16,256}")) credentials.put("csrf", csrf);
                store.credentials(credentials);
                return new JSONObject().put("status", status).put("body", body);
            } finally { connection.disconnect(); java.util.Arrays.fill(payload, (byte) 0); }
        }
    }
    private static String read(InputStream input) throws Exception {
        if (input == null) return "";
        try (input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) { if (out.size() + count > QueueRules.MAX_RESPONSE) throw new IllegalStateException("Ответ сервера слишком большой."); out.write(buffer, 0, count); }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
