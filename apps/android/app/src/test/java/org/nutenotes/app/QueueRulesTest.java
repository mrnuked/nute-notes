package org.nutenotes.app;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class QueueRulesTest {
    private JSONObject operation(String id) throws Exception { return new JSONObject().put("id", id).put("data", new JSONObject().put("v", 1).put("iv", "AAECAwQFBgcICQoL").put("ciphertext", "AAECAwQFBgcICQoLDA0ODw==")); }
    private static final String ID = "d6fb3ce6-5441-4bf5-874f-82faf1d5c678";
    @Test public void validEncryptedOperationsArePreserved() throws Exception { JSONArray result = QueueRules.operations(new JSONArray().put(operation(ID))); assertEquals(ID, result.getJSONObject(0).getString("id")); assertEquals(2, result.getJSONObject(0).length()); }
    @Test public void rejectPlaintextAndDuplicateIds() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> QueueRules.operations(new JSONArray().put(operation(ID).put("body", "private"))));
        assertThrows(IllegalArgumentException.class, () -> QueueRules.operations(new JSONArray().put(operation(ID)).put(operation(ID))));
        assertThrows(IllegalArgumentException.class, () -> QueueRules.operations(new JSONArray().put(operation("not-a-uuid"))));
    }
    @Test public void malformedEnvelopeCannotEnterQueue() throws Exception {
        JSONObject bad = operation(ID); bad.getJSONObject("data").put("iv", "AA==");
        assertThrows(IllegalArgumentException.class, () -> QueueRules.operations(new JSONArray().put(bad)));
        JSONObject truncated = operation(ID); truncated.getJSONObject("data").put("ciphertext", "AA==");
        assertThrows(IllegalArgumentException.class, () -> QueueRules.operations(new JSONArray().put(truncated)));
        JSONObject stringVersion = operation(ID); stringVersion.getJSONObject("data").put("v", "1");
        assertThrows(IllegalArgumentException.class, () -> QueueRules.operations(new JSONArray().put(stringVersion)));
    }
    @Test public void acknowledgementsAreExactIdsAndUnicodeUsesByteBudget() throws Exception {
        assertEquals(1, QueueRules.ids(new JSONArray().put(ID).put(ID)).size());
        assertThrows(IllegalArgumentException.class, () -> QueueRules.ids(new JSONArray().put("*")));
        assertEquals(4, QueueRules.bytes("🗝"));
    }
    @Test public void checkpointCapacityDoesNotExpandNormalRequestsOrSecretFields() {
        QueueRules.requestSize("sync_checkpoint", 20 * 1024 * 1024);
        assertThrows(IllegalArgumentException.class, () -> QueueRules.requestSize("sync_checkpoint", 20 * 1024 * 1024 + 1));
        QueueRules.requestSize("sync_push", 4 * 1024 * 1024);
        assertThrows(IllegalArgumentException.class, () -> QueueRules.requestSize("sync_push", 4 * 1024 * 1024 + 1));
        QueueRules.localSize("cache", 64 * 1024 * 1024 + 64 * 1024);
        assertThrows(IllegalArgumentException.class, () -> QueueRules.localSize("cache", 64 * 1024 * 1024 + 64 * 1024 + 1));
        assertThrows(IllegalArgumentException.class, () -> QueueRules.localSize("unlock", 24 * 1024 * 1024 + 1));
    }
}
