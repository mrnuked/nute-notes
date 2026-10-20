package org.nutenotes.app;
import android.app.Application;
public final class NuteApplication extends Application {
    @Override public void onCreate() { super.onCreate(); OutboxWorker.periodic(this); OutboxWorker.schedule(this); }
}
