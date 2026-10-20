package org.nutenotes.app;

import android.app.Instrumentation;
import android.graphics.Insets;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Touch and native InputConnection only for input. JS observes DOM/geometry; it never sets input values/focus. */
@RunWith(AndroidJUnit4.class)
public class KeyboardInstrumentedTest {
    private final Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    @Before public void fixtureOnly() throws Exception {
        assumeTrue("ime".equals(InstrumentationRegistry.getArguments().getString("nuteFixturePhase")));
        assertEquals("http://127.0.0.1:4187",NuteApi.ORIGIN);
        NuteStore store=NuteStore.get(ApplicationProvider.getApplicationContext());store.clear(true);store.save(new JSONObject().put("cache",JSONObject.NULL));
        org.json.JSONArray pending=store.load().getJSONArray("pending"),ids=new org.json.JSONArray();for(int i=0;i<pending.length();i++)ids.put(pending.getJSONObject(i).getString("id"));store.ack(ids);
        control("{\"unavailable\":false,\"delayBootstrap\":false,\"delayPull\":false}");
    }
    private WebView web(View view) { if(view instanceof WebView)return (WebView)view;if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++){WebView found=web(((ViewGroup)view).getChildAt(i));if(found!=null)return found;}return null; }
    private String js(ActivityScenario<MainActivity> scenario,String script)throws Exception {
        CountDownLatch done=new CountDownLatch(1);AtomicReference<String> result=new AtomicReference<>();scenario.onActivity(activity->web(activity.getWindow().getDecorView()).evaluateJavascript(script,value->{result.set(value);done.countDown();}));assertTrue(done.await(5,TimeUnit.SECONDS));return result.get();
    }
    private void await(ActivityScenario<MainActivity> scenario,String condition,long timeout)throws Exception {
        long end=SystemClock.uptimeMillis()+timeout;while(SystemClock.uptimeMillis()<end){if("true".equals(js(scenario,condition)))return;Thread.sleep(80);}fail(condition+"; active="+js(scenario,"document.activeElement?.id")+"; inert="+js(scenario,"document.getElementById('login-form')?.inert"));
    }
    private JSONObject control(String payload)throws Exception {
        java.net.HttpURLConnection connection=(java.net.HttpURLConnection)new java.net.URL("http://127.0.0.1:4187/control").openConnection();connection.setRequestMethod("POST");connection.setDoOutput(true);try(java.io.OutputStream out=connection.getOutputStream()){out.write(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));}assertEquals(200,connection.getResponseCode());String response;try(java.io.InputStream in=connection.getInputStream()){response=new String(in.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);}connection.disconnect();return new JSONObject(response);
    }
    private void tap(float x,float y) {
        long down=SystemClock.uptimeMillis();MotionEvent first=MotionEvent.obtain(down,down,MotionEvent.ACTION_DOWN,x,y,0),last=MotionEvent.obtain(down,down+40,MotionEvent.ACTION_UP,x,y,0);
        first.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);last.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);try{assertTrue(instrumentation.getUiAutomation().injectInputEvent(first,true));assertTrue(instrumentation.getUiAutomation().injectInputEvent(last,true));}finally{first.recycle();last.recycle();}
    }
    private void tapEmail(ActivityScenario<MainActivity> scenario)throws Exception {
        JSONObject point=new JSONObject(js(scenario,"(()=>{const r=document.getElementById('email').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth};})()"));float[] xy=new float[2];scenario.onActivity(activity->{WebView view=web(activity.getWindow().getDecorView());int[] origin=new int[2];view.getLocationOnScreen(origin);float scale=view.getWidth()/(float)point.optDouble("w");xy[0]=origin[0]+(float)point.optDouble("x")*scale;xy[1]=origin[1]+(float)point.optDouble("y")*scale;});tap(xy[0],xy[1]);
    }
    private void type(ActivityScenario<MainActivity> scenario,String text) {
        scenario.onActivity(activity->{InputConnection connection=web(activity.getWindow().getDecorView()).onCreateInputConnection(new EditorInfo());assertNotNull("Focused input connection",connection);assertTrue(connection.commitText(text,1));});
    }
    private boolean ime(ActivityScenario<MainActivity> scenario) {
        boolean[] visible={false};scenario.onActivity(activity->{WindowInsets insets=activity.getWindow().getDecorView().getRootWindowInsets();visible[0]=insets!=null&&insets.isVisible(WindowInsets.Type.ime());});return visible[0];
    }
    private void awaitIme(ActivityScenario<MainActivity> scenario)throws Exception {long end=SystemClock.uptimeMillis()+6000;while(!ime(scenario)&&SystemClock.uptimeMillis()<end)Thread.sleep(100);assertTrue("Keyboard visible",ime(scenario));}
    private void awaitRussian(ActivityScenario<MainActivity> scenario)throws Exception {AtomicReference<String> locale=new AtomicReference<>("");long end=SystemClock.uptimeMillis()+5000;while(SystemClock.uptimeMillis()<end){scenario.onActivity(activity->locale.set(activity.getSystemService(InputMethodManager.class).getCurrentInputMethodSubtype().getLocale()));if("ru".equals(locale.get()))return;Thread.sleep(100);}assertEquals("Selected keyboard subtype","ru",locale.get());}
    private void screenshot(ActivityScenario<MainActivity> scenario,String name)throws Exception {
        scenario.onActivity(activity->activity.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE));Thread.sleep(250);android.graphics.Bitmap bitmap=instrumentation.getUiAutomation().takeScreenshot();java.io.File file=new java.io.File(ApplicationProvider.getApplicationContext().getExternalFilesDir(null),name+".png");try(java.io.OutputStream out=new java.io.FileOutputStream(file)){assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out));}bitmap.recycle();scenario.onActivity(activity->activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE));
    }
    @Test public void firstTouchAndTypingDoNotWaitForBootstrap()throws Exception {
        control("{\"delayBootstrap\":true}");
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            await(scenario,"!!window.NuteNative && !!document.getElementById('email')",5000);
            long end=SystemClock.uptimeMillis()+5000;while(control("{}").getInt("bootstrapWaiting")==0&&SystemClock.uptimeMillis()<end)Thread.sleep(50);assertTrue(control("{}").getInt("bootstrapWaiting")>0);
            tapEmail(scenario);await(scenario,"document.activeElement.id==='email'",1500);awaitIme(scenario);type(scenario,"touch@example.test");await(scenario,"document.getElementById('email').value==='touch@example.test'",2000);
            assertTrue("Bootstrap still pending during real input",control("{}").getInt("bootstrapWaiting")>0);screenshot(scenario,"keyboard-first-touch");
        } finally {control("{\"delayBootstrap\":false}");}
    }
    @Test public void languagePickerPreservesFocusAndTyping()throws Exception {
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            // Wait for a completed bootstrap, not merely the form's default pre-module inert=false.
            NuteStore store=NuteStore.get(ApplicationProvider.getApplicationContext());long bootDeadline=SystemClock.uptimeMillis()+5000;while(store.credentials().optString("csrf","").isEmpty()&&SystemClock.uptimeMillis()<bootDeadline)Thread.sleep(50);
            assertFalse("Bootstrap completed",store.credentials().optString("csrf","").isEmpty());
            await(scenario,"!!window.NuteNative && !document.getElementById('login-form').inert",5000);tapEmail(scenario);
            screenshot(scenario,"keyboard-after-tap");
            scenario.onActivity(activity->{WebView view=web(activity.getWindow().getDecorView());System.out.println("IME native focus="+view.hasFocus()+", window="+view.hasWindowFocus()+", focusable="+view.isFocusable()+", touchFocusable="+view.isFocusableInTouchMode()+", size="+view.getWidth()+"x"+view.getHeight());});
            System.out.println("IME DOM "+js(scenario,"({active:document.activeElement?.id,inert:document.getElementById('login-form').inert,connected:document.getElementById('email').isConnected,viewport:innerHeight,visual:visualViewport.height})"));
            await(scenario,"document.activeElement.id==='email'",2000);awaitIme(scenario);type(scenario,"before");await(scenario,"document.getElementById('email').value==='before'",2000);
            AtomicReference<MainActivity> original=new AtomicReference<>();scenario.onActivity(activity->{original.set(activity);activity.getSystemService(InputMethodManager.class).showInputMethodPicker();});
            AccessibilityNodeInfo target=null;long end=SystemClock.uptimeMillis()+5000;
            while(target==null&&SystemClock.uptimeMillis()<end){AccessibilityNodeInfo root=instrumentation.getUiAutomation().getRootInActiveWindow();if(root!=null){java.util.List<AccessibilityNodeInfo> nodes=root.findAccessibilityNodeInfosByText("Russian");if(!nodes.isEmpty())target=nodes.get(0);}if(target==null)Thread.sleep(100);}
            assertNotNull("Enable English and Russian subtypes in isolated AOSP IME",target);Rect bounds=new Rect();target.getBoundsInScreen(bounds);tap(bounds.centerX(),bounds.centerY());
            awaitRussian(scenario);awaitIme(scenario);await(scenario,"document.activeElement.id==='email'",3000);scenario.onActivity(activity->assertSame("Picker must not recreate Activity",original.get(),activity));type(scenario,"after");await(scenario,"document.getElementById('email').value==='beforeafter'",2000);screenshot(scenario,"keyboard-language-picker");
            // Keyboard opening and picker dismissal must not make the input's center inaccessible.
            assertEquals("true",js(scenario,"(()=>{const r=document.getElementById('email').getBoundingClientRect();return r.y>=0&&r.bottom<=visualViewport.height+visualViewport.offsetTop;})()"));
        }
    }
    @Test public void handledInsetsAreZeroedBeforeReachingWebView()throws Exception {
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity->{WebView view=web(activity.getWindow().getDecorView());ViewGroup root=(ViewGroup)view.getParent();AtomicReference<WindowInsets> child=new AtomicReference<>();view.setOnApplyWindowInsetsListener((v,insets)->{child.set(insets);return insets;});
                int handled=WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime();WindowInsets supplied=new WindowInsets.Builder().setInsets(WindowInsets.Type.systemBars(),Insets.of(12,60,8,72)).setInsets(WindowInsets.Type.ime(),Insets.of(0,0,0,700)).setInsets(WindowInsets.Type.systemGestures(),Insets.of(20,0,20,24)).build();root.dispatchApplyWindowInsets(supplied);
                assertEquals(700,root.getPaddingBottom());assertEquals(60,root.getPaddingTop());assertNotNull(child.get());assertEquals("Parent already padded these regions; children must receive zero",Insets.NONE,child.get().getInsets(handled));assertEquals("Unconsumed gesture insets remain",Insets.of(20,0,20,24),child.get().getInsets(WindowInsets.Type.systemGestures()));
                view.setOnApplyWindowInsetsListener(null);root.requestApplyInsets();});
        }
    }
}
