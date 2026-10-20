package org.nutenotes.app;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public final class OutboxWorker extends Worker {
    public OutboxWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    private static Constraints network() { return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(); }
    static void schedule(Context context) {
        WorkManager.getInstance(context).enqueueUniqueWork("nute-outbox", ExistingWorkPolicy.APPEND_OR_REPLACE, new OneTimeWorkRequest.Builder(OutboxWorker.class).setConstraints(network()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }
    static void periodic(Context context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("nute-outbox-recovery", ExistingPeriodicWorkPolicy.KEEP, new PeriodicWorkRequest.Builder(OutboxWorker.class, 15, TimeUnit.MINUTES).setConstraints(network()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }
    @NonNull @Override public Result doWork() {
        NuteStore store = NuteStore.get(getApplicationContext());
        try {
            if (store.nextBatch().length() == 0) return Result.success();
            NuteApi api = new NuteApi(store);
            JSONObject bootstrap = api.request("bootstrap", "GET", new JSONObject());
            if (bootstrap.getInt("status") != 200) { store.lastError("Нет связи с сервером. Изменения сохранены на устройстве."); return Result.retry(); }
            for (int batch = 0; batch < 12 && !isStopped(); batch++) {
                JSONArray operations = store.nextBatch(); if (operations.length() == 0) { store.lastError(null); return Result.success(); }
                JSONObject response = api.request("sync_push", "POST", new JSONObject().put("operations", operations));
                int status = response.getInt("status"); JSONObject body = response.getJSONObject("body");
                if (status == 401) { store.lastError("Для синхронизации нужно снова войти в NUTE."); return Result.success(); }
                if (status >= 500 || status == 429) { store.lastError("Синхронизация будет повторена. Изменения сохранены на устройстве."); return Result.retry(); }
                if (status < 200 || status >= 300) { store.lastError("Не удалось отправить изменения (" + status + "). Откройте NUTE."); return Result.success(); }
                JSONArray accepted = body.getJSONArray("accepted");
                QueueRules.require(accepted.length() > 0, "Сервер не подтвердил изменения.");
                // Keep accepted operations locally until UI saves its merged encrypted cache and calls ack.
                store.delivered(accepted, operations); store.lastError(null);
            }
            return Result.retry();
        } catch (Exception error) {
            try { store.lastError("Нет связи с сервером. Изменения сохранены на устройстве."); } catch (Exception ignored) { }
            return Result.retry();
        }
    }
}
