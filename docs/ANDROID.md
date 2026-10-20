# Сборка Nute Notes для Android

Android в выпуске 0.5.0 доступен исходниками; готовый APK не опубликован. Debug-сборка и модульные тесты прошли, но release-сборка и работа на физическом устройстве не проверялись. Собирайте под свой сервер и проверяйте на тестовых данных.

Нужны JDK 17, Android SDK API 36 с совместимыми build-tools и интернет для Gradle. Минимальная версия Android приложения — 8.0/API 26.

## Адрес и debug APK

Из корня репозитория:

```bash
cd apps/android
./gradlew :app:assembleDebug -PnuteOrigin=https://notes.example.org
```

В Windows используйте `.\gradlew.bat`. Вместо примера укажите свой HTTPS-origin. Адрес встраивается в сборку, это не переключатель аккаунтов.

Debug APK появится в `app/build/outputs/apk/debug/`. Для постоянного распространения используйте собственную release-подпись.

`-PnuteTestOrigin=http://127.0.0.1:4173` предназначен **только для локальных debug-тестов**, при доступном loopback fixture. Например, `adb reverse tcp:4173 tcp:4173` может связать его с тестовым сервером компьютера. Не используйте тестовый HTTP-origin для реальных заметок или release.

## Release-подпись

Репозиторий не содержит ключей подписи и паролей. Создайте их у себя. Из корня репозитория:

```bash
mkdir -p private/android-signing
keytool -genkeypair -keystore private/android-signing/nute-release.p12 \
  -storetype PKCS12 -alias nute-notes -keyalg RSA -keysize 3072 -validity 10000
```

Введите пароль интерактивно. Создайте локальный `private/android-signing/signing.properties`:

```properties
storePassword=YOUR_LOCAL_KEYSTORE_PASSWORD
keyAlias=nute-notes
keyPassword=YOUR_LOCAL_KEY_PASSWORD
```

Подставьте свои секреты. Это формат Java Properties: экранируйте `\` и специальные символы при необходимости. Ограничьте доступ к каталогу средствами ОС.

```bash
cd apps/android
./gradlew :app:assembleRelease -PnuteOrigin=https://notes.example.org
```

Результат — `app/build/outputs/apk/release/`. Проверьте подпись командой Android SDK `apksigner verify --verbose путь-к.apk` и поведение на устройстве.

Никогда не коммитьте `private/`, signing.properties, keystore или их копии. Сохраните ключ и пароль в защищённой копии: обновление приложения требует прежней подписи. Изменение ключа или идентификатора не переносит старые локальные правки.

## Установка и синхронизация

Установите свой APK и войдите на сервер этой сборки. Первый вход требует сети. После загрузки коллекции поддерживается зашифрованная офлайн-очередь.

Фоновую отправку планирует Android. ОС и производитель могут задержать её из-за энергосбережения, ограничения фона, принудительной остановки и выключения. После принудительной остановки откройте приложение снова. Мгновенная отправка после любого закрытия не гарантируется.

Перед обновлением, сменой адреса или удалением дождитесь «Синхронизировано» и сохраните экспорт. Сброс приложения может удалить неотправленные правки.
