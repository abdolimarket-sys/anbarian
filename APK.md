# ساخت APK انبارین

## روش ۱ — GitHub Actions (پیشنهادی)

1. این پروژه را روی GitHub پوش کن.
2. برو به تب **Actions**.
3. workflow به نام **Build Android APK** را اجرا کن (Run workflow).
4. بعد از اتمام، از بخش **Artifacts** فایل `anbarin-debug-apk` را دانلود کن.

APK دیباگ بدون امضای فروشگاهی است؛ برای نصب روی گوشی کافی است (Install from unknown sources).

## روش ۲ — روی سیستم خودت

### پیش‌نیاز
- Node.js 20
- Android Studio + SDK
- JDK 17

### دستورات

```bash
npm install
npm run build
npx cap add android
npx cap sync android
npx cap open android
```

در Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**

یا از خط فرمان:

```bash
cd android
./gradlew assembleDebug
```

خروجی:

`android/app/build/outputs/apk/debug/app-debug.apk`

### امضای Release (اختیاری)

در Android Studio یک keystore بساز و `assembleRelease` بزن.

## شناسه اپ

- applicationId: `ir.azar.anbar`
- نام: انبارین
