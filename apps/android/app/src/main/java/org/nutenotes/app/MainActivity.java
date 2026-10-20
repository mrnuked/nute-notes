package org.nutenotes.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String LOCAL = "https://appassets.androidplatform.net";
    private static final String ENTRY = LOCAL + "/assets/index.html";
    private static final int SAVE_FILE = 71, OPEN_FILE = 72;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PendingFile pendingFile;
    private static final class PendingFile { final String id, data; final JavaScriptReplyProxy reply; PendingFile(String id, String data, JavaScriptReplyProxy reply) { this.id = id; this.data = data; this.reply = reply; } }
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState); getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        FrameLayout root = new FrameLayout(this); web = new WebView(this); root.addView(web, new FrameLayout.LayoutParams(-1, -1)); setContentView(root); root.setBackgroundColor(0xff1d1d1f);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                int handled = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime();
                android.graphics.Insets padding = insets.getInsets(handled); root.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                // The WebView already fits inside this padding; forwarding it again shrinks its viewport twice.
                return new WindowInsets.Builder(insets).setInsets(handled, android.graphics.Insets.NONE).build();
            }
            root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.replaceSystemWindowInsets(0, 0, 0, 0);
        });
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setAllowFileAccess(false); settings.setAllowContentAccess(true); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(false); settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { new AlertDialog.Builder(this).setTitle("Обновите Android System WebView").setMessage("Для защищённой работы NUTE требуется актуальный Android System WebView.").setPositiveButton("Закрыть", (d, w) -> finish()).show(); return; }
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!"GET".equals(request.getMethod()) || !local(request.getUrl())) return denied();
                WebResourceResponse response = assets.shouldInterceptRequest(request.getUrl());
                if (response == null) return denied();
                HashMap<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
                headers.put("X-Content-Type-Options", "nosniff"); headers.put("Cache-Control", "no-store"); response.setResponseHeaders(headers); return response;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && request.getUrl().toString().equals(ENTRY)) return false;
                if (request.isForMainFrame()) openExternal(request.getUrl()); return true;
            }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) { root.removeView(view); view.destroy(); web = null; Toast.makeText(MainActivity.this, "Открываем сохранённые заметки заново", Toast.LENGTH_SHORT).show(); recreate(); return true; }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null); fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE);
                try { startActivityForResult(intent, OPEN_FILE); } catch (Exception unavailable) { callback.onReceiveValue(null); fileCallback = null; } return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.addWebMessageListener(web, "NuteAndroid", java.util.Collections.singleton(LOCAL), (view, message, sourceOrigin, isMainFrame, reply) -> {
            if (!isMainFrame || !LOCAL.equals(sourceOrigin.toString()) || !ENTRY.equals(view.getUrl())) return;
            if (message.getType() != androidx.webkit.WebMessageCompat.TYPE_STRING) return;
            String text = message.getData(); if (text == null || text.length() > QueueRules.MAX_BRIDGE || QueueRules.bytes(text) > QueueRules.MAX_BRIDGE) return;
            executor.execute(() -> dispatch(text, reply));
        });
        web.loadUrl(ENTRY);
    }
    private static boolean local(Uri uri) { return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) && uri.getPort() == -1 && uri.getPath() != null && uri.getPath().startsWith("/assets/"); }
    private static WebResourceResponse denied() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
    private void dispatch(String text, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            JSONObject message = new JSONObject(text); id = message.getString("id"); QueueRules.require(id.matches("[0-9]{1,16}"), "Некорректный запрос.");
            JSONObject value = message.optJSONObject("value"); if (value == null) value = new JSONObject();
            String method = message.getString("method"); NuteStore store = NuteStore.get(this); JSONObject result = new JSONObject().put("ok", true);
            switch (method) {
                case "load": result = store.load(); break;
                case "save": store.save(value); break;
                case "enqueue": store.enqueue(value.getJSONArray("operations")); OutboxWorker.schedule(this); break;
                case "ack": store.ack(value.getJSONArray("ids")); break;
                case "clear": {
                    if (!value.optBoolean("credentials", false)) { store.clear(false); break; }
                    String requestId = id;
                    networkExecutor.execute(() -> { try { synchronized (NuteApi.LOCK) { store.clear(true); } respond(reply, requestId, new JSONObject().put("ok", true), null); } catch (Exception error) { respond(reply, requestId, null, "Не удалось завершить сеанс."); } });
                    return;
                }
                case "request": {
                    JSONObject request = value; String requestId = id;
                    networkExecutor.execute(() -> request(request, requestId, reply, store)); return;
                }
                case "openExternal": { Uri uri = Uri.parse(value.getString("url")); QueueRules.require(externalAllowed(uri), "Ссылка недоступна."); runOnUiThread(() -> openExternal(uri)); break; }
                case "saveFile": { String name = value.getString("name"), data = value.getString("data"); QueueRules.require(name.matches("[A-Za-z0-9._-]{1,120}\\.json") && QueueRules.bytes(data) <= QueueRules.MAX_BACKUP, "Некорректный файл резервной копии."); new JSONObject(data); String requestId = id; runOnUiThread(() -> chooseSave(name, new PendingFile(requestId, data, reply))); return; }
                default: throw new IllegalArgumentException("Неизвестное действие приложения.");
            }
            respond(reply, id, result, null);
        } catch (Exception error) { respond(reply, id, null, error instanceof IllegalArgumentException ? error.getMessage() : "Действие не выполнено. Изменения сохранены на устройстве; проверьте подключение и повторите."); }
    }
    private void request(JSONObject value, String id, JavaScriptReplyProxy reply, NuteStore store) {
        try {
            String action = value.getString("action"), verb = value.optString("method", "POST"); JSONObject data = value.optJSONObject("data");
            JSONObject result = new NuteApi(store).request(action, verb, data == null ? new JSONObject() : data);
            if ((action.equals("login") || action.equals("resume")) && result.getInt("status") == 200) { store.lastError(null); OutboxWorker.schedule(this); }
            respond(reply, id, result, null);
        } catch (Exception error) { respond(reply, id, null, "Нет связи с сервером. Локальные изменения сохранены на устройстве."); }
    }
    private void respond(JavaScriptReplyProxy reply, String id, JSONObject value, String error) {
        try { String result = new JSONObject().put("id", id).put(error == null ? "result" : "error", error == null ? value : error).toString(); runOnUiThread(() -> { if (!isDestroyed() && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) try { reply.postMessage(result); } catch (Exception ignored) { } }); } catch (Exception ignored) { }
    }
    private static boolean externalAllowed(Uri uri) { return "https".equals(uri.getScheme()) && ("icloud.com".equals(uri.getHost()) || "www.icloud.com".equals(uri.getHost())) && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443); }
    private void openExternal(Uri uri) { if (!externalAllowed(uri)) return; try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception unavailable) { Toast.makeText(this, "Не найден браузер для открытия ссылки", Toast.LENGTH_SHORT).show(); } }
    private void chooseSave(String name, PendingFile file) {
        if (pendingFile != null) { respond(file.reply, file.id, null, "Завершите сохранение предыдущей копии."); return; } pendingFile = file;
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name), SAVE_FILE); }
        catch (Exception unavailable) { pendingFile = null; respond(file.reply, file.id, null, "Не удалось открыть выбор файла."); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == OPEN_FILE && fileCallback != null) { fileCallback.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null); fileCallback = null; }
        if (request == SAVE_FILE && pendingFile != null) {
            PendingFile file = pendingFile; pendingFile = null;
            if (result != RESULT_OK || data == null || data.getData() == null) { respond(file.reply, file.id, null, "Сохранение отменено."); return; }
            Uri uri = data.getData(); executor.execute(() -> { try (java.io.OutputStream out = getContentResolver().openOutputStream(uri, "wt")) { if (out == null) throw new IllegalStateException(); out.write(file.data.getBytes(StandardCharsets.UTF_8)); respond(file.reply, file.id, new JSONObject().put("ok", true), null); } catch (Exception error) { respond(file.reply, file.id, null, "Не удалось сохранить файл."); } });
        }
    }
    @Override public boolean onKeyUp(int keyCode, KeyEvent event) { if (Build.VERSION.SDK_INT < 33 && keyCode == KeyEvent.KEYCODE_BACK) { handleBack(); return true; } return super.onKeyUp(keyCode, event); }
    private void handleBack() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("(()=>{const w=document.getElementById('workspace');if(w&&!w.hidden&&w.classList.contains('editing')){document.getElementById('mobile-back').click();return true;}return false;})()", result -> { if (!"true".equals(result)) finish(); });
    }
    @Override protected void onDestroy() { if (fileCallback != null) fileCallback.onReceiveValue(null); if (web != null) web.destroy(); executor.shutdown(); networkExecutor.shutdown(); super.onDestroy(); }
}
