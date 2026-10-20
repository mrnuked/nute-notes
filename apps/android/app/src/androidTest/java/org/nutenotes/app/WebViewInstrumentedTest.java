package org.nutenotes.app;
import android.webkit.WebView;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class WebViewInstrumentedTest {
    private WebView web(View view) { if (view instanceof WebView) return (WebView) view; if (view instanceof ViewGroup) for (int i=0;i<((ViewGroup)view).getChildCount();i++) { WebView found=web(((ViewGroup)view).getChildAt(i));if(found!=null)return found; } return null; }
    private String js(ActivityScenario<MainActivity> scenario,String script)throws Exception {
        CountDownLatch done=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>();
        scenario.onActivity(activity->web(activity.getWindow().getDecorView()).evaluateJavascript(script, result->{value.set(result);done.countDown();}));
        assertTrue("JS callback",done.await(10,TimeUnit.SECONDS));return value.get();
    }
    private void await(ActivityScenario<MainActivity> scenario,String condition)throws Exception {
        long end=System.currentTimeMillis()+45000;String last="";while(System.currentTimeMillis()<end){last=js(scenario,condition);if(last.equals("true"))return;Thread.sleep(200);}fail("WebView condition: "+condition+"; last="+last+"; message="+js(scenario,"document.getElementById('auth-message')?.textContent"));
    }
    private void offline(boolean value)throws Exception {
        control("{\"unavailable\":"+value+"}");
    }
    private JSONObject control(String payload)throws Exception {
        java.net.HttpURLConnection c=(java.net.HttpURLConnection)new java.net.URL("http://127.0.0.1:4187/control").openConnection();c.setRequestMethod("POST");c.setDoOutput(true);try(java.io.OutputStream out=c.getOutputStream()){out.write(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));}assertEquals(200,c.getResponseCode());String value;try(java.io.InputStream in=c.getInputStream()){value=new String(in.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);}c.disconnect();return new JSONObject(value);
    }
    private void phase(String expected) {
        assumeTrue(expected.equals(androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("nuteFixturePhase")));
    }
    private void capture(ActivityScenario<MainActivity> scenario,String name)throws Exception {
        // Synthetic debug fixture only. Production FLAG_SECURE is never disabled by app code.
        scenario.onActivity(activity->activity.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE));Thread.sleep(250);
        android.graphics.Bitmap image=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        java.io.File target=new java.io.File(ApplicationProvider.getApplicationContext().getExternalFilesDir(null),name+".png");
        try(java.io.OutputStream out=new java.io.FileOutputStream(target)){assertTrue(image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out));}image.recycle();
        scenario.onActivity(activity->activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE));
    }
    @Test public void localWebViewLoginAndDurableOfflineEdit()throws Exception {
        phase("seed");assertEquals("http://127.0.0.1:4187",NuteApi.ORIGIN);NuteStore store=NuteStore.get(ApplicationProvider.getApplicationContext());store.clear(true);store.save(new JSONObject().put("cache",JSONObject.NULL));org.json.JSONArray old=store.load().getJSONArray("pending"),ids=new org.json.JSONArray();for(int i=0;i<old.length();i++)ids.put(old.getJSONObject(i).getString("id"));store.ack(ids);offline(false);
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            await(scenario,"!!window.NuteNative && !document.getElementById('login-form').inert");
            assertEquals("\"https://appassets.androidplatform.net/assets/index.html\"",js(scenario,"location.href"));
            capture(scenario,"login");
            js(scenario,"document.getElementById('email').value='android@example.test';document.getElementById('login-form').requestSubmit();");await(scenario,"!document.getElementById('password-step').hidden");
            js(scenario,"document.getElementById('password').value='Android fixture password 2026!';document.getElementById('login-form').requestSubmit();");await(scenario,"!document.getElementById('workspace').hidden");
            await(scenario,"document.querySelectorAll('.note-card').length===1");
            js(scenario,"document.querySelector('.note-card').click()");await(scenario,"document.getElementById('note-title').value==='Android fixture'");
            capture(scenario,"editor");
            offline(true);
            js(scenario,"document.getElementById('note-title').value='Android offline durable edit';document.getElementById('note-title').dispatchEvent(new Event('input',{bubbles:true}));");
            long end=System.currentTimeMillis()+15000;while(store.load().getJSONArray("pending").length()==0&&System.currentTimeMillis()<end)Thread.sleep(200);
            assertTrue("Edit durably queued before dismiss",store.load().getJSONArray("pending").length()>0);assertNotNull(store.load().optJSONObject("unlock"));
        }
    }
    @Test public void reopenOfflineAfterBackgroundDeliveryPreservesLatestEdit()throws Exception {
        phase("restore");offline(true);NuteStore store=NuteStore.get(ApplicationProvider.getApplicationContext());
        assertTrue("Delivered remains available until cache catches up",store.load().getJSONArray("pending").length()>0);assertEquals("Worker already uploaded",0,store.nextBatch().length());
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
            await(scenario,"!document.getElementById('workspace').hidden");await(scenario,"document.querySelector('.note-card')?.textContent.includes('Android offline durable edit')===true");
            assertEquals("Latest edit survives restart offline","true",js(scenario,"document.querySelector('.note-card').textContent.includes('Android offline durable edit')"));
        }
    }
    @Test public void delayedHttpCannotBlockDurableLocalEnqueue()throws Exception {
        phase("network-gate");assertEquals("http://127.0.0.1:4187",NuteApi.ORIGIN);NuteStore store=NuteStore.get(ApplicationProvider.getApplicationContext());store.clear(true);store.save(new JSONObject().put("cache",JSONObject.NULL));offline(false);
        String id=java.util.UUID.randomUUID().toString();
        try {
            try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)){
                await(scenario,"!!window.NuteNative && !document.getElementById('login-form').inert");control("{\"delayPull\":true}");
                js(scenario,"window.httpDone=false;NuteNative.request({action:'sync_pull',method:'POST',data:{after:0,pendingIds:[]}}).finally(()=>window.httpDone=true);");
                long end=System.currentTimeMillis()+5000;while(control("{}").getInt("waiting")==0&&System.currentTimeMillis()<end)Thread.sleep(50);assertEquals(1,control("{}").getInt("waiting"));
                long start=System.currentTimeMillis();js(scenario,"window.queued=false;NuteNative.enqueue({operations:[{id:'"+id+"',data:{v:1,iv:'AAECAwQFBgcICQoL',ciphertext:'AAECAwQFBgcICQoLDA0ODw=='}}]}).then(()=>window.queued=true);");await(scenario,"window.queued===true");
                assertTrue("Local enqueue must not wait for blocked HTTP",System.currentTimeMillis()-start<2000);assertEquals("false",js(scenario,"window.httpDone"));
            }
            assertTrue("Enqueued change survives Activity dismissal",store.load().getJSONArray("pending").toString().contains(id));
        } finally { store.ack(new org.json.JSONArray().put(id));control("{\"delayPull\":false}"); }
    }
}
