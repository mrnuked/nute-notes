package org.nutenotes.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecretBox {
    private static final String ALIAS = "nute-native-storage-v1";
    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    static byte[] seal(String field, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(("NUTE/native/v1/" + field).getBytes(StandardCharsets.UTF_8));
        byte[] plain = value.getBytes(StandardCharsets.UTF_8);
        try { byte[] encrypted = cipher.doFinal(plain); return ByteBuffer.allocate(1 + 12 + encrypted.length).put((byte) 1).put(cipher.getIV()).put(encrypted).array(); }
        finally { java.util.Arrays.fill(plain, (byte) 0); }
    }
    static String open(String field, byte[] envelope) throws Exception {
        if (envelope.length < 29 || envelope[0] != 1) throw new IllegalStateException("Не удалось прочитать защищённые данные приложения.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, envelope, 1, 12)); cipher.updateAAD(("NUTE/native/v1/" + field).getBytes(StandardCharsets.UTF_8));
        byte[] plain = cipher.doFinal(envelope, 13, envelope.length - 13);
        try { return new String(plain, StandardCharsets.UTF_8); } finally { java.util.Arrays.fill(plain, (byte) 0); }
    }
}
