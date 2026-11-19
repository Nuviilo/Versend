package com.versend.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private static final String APP_INDEX_URL = "https://appassets.androidplatform.net/assets/public/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermissionRequest;

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (filePathCallback == null) return;
                Uri[] results = null;
                if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
                    Intent data = result.getData();
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        List<Uri> uris = new ArrayList<>(count);
                        for (int i = 0; i < count; i++) {
                            Uri itemUri = data.getClipData().getItemAt(i).getUri();
                            if (itemUri != null) uris.add(itemUri);
                        }
                        results = uris.toArray(new Uri[0]);
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            });

    private final ActivityResultLauncher<String> cameraPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (pendingWebPermissionRequest != null) {
                    if (granted) {
                        pendingWebPermissionRequest.grant(pendingWebPermissionRequest.getResources());
                    } else {
                        pendingWebPermissionRequest.deny();
                    }
                    pendingWebPermissionRequest = null;
                }
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.addJavascriptInterface(new AndroidBlobBridge(), "VersendAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean needsCamera = false;
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                            needsCamera = true;
                            break;
                        }
                    }
                    if (!needsCamera) {
                        request.grant(request.getResources());
                        return;
                    }
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                    } else {
                        if (pendingWebPermissionRequest != null) {
                            pendingWebPermissionRequest.deny();
                        }
                        pendingWebPermissionRequest = request;
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                Intent chooser = Intent.createChooser(intent, "Select files");
                try {
                    fileChooserLauncher.launch(chooser);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(
                    String url,
                    String userAgent,
                    String contentDisposition,
                    String mimeType,
                    long contentLength) {
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                if (url != null && url.startsWith("blob:")) {
                    String safeUrl = JSONObject.quote(url);
                    String safeName = JSONObject.quote(fileName);
                    String safeMime = JSONObject.quote(mimeType != null ? mimeType : "application/octet-stream");
                    String js = "(async function(){"
                            + "try{"
                            + "const r=await fetch(" + safeUrl + ");"
                            + "const b=await r.blob();"
                            + "const fr=new FileReader();"
                            + "fr.onloadend=function(){"
                            + "window.VersendAndroid.saveDataUrl(" + safeName + "," + safeMime + ",fr.result);"
                            + "};"
                            + "fr.readAsDataURL(b);"
                            + "}catch(e){window.VersendAndroid.onSaveError(String(e));}"
                            + "})();";
                    webView.evaluateJavascript(js, null);
                } else if (url != null && url.startsWith("data:")) {
                    new AndroidBlobBridge().saveDataUrl(fileName, mimeType, url);
                }
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            }
        });

        webView.loadUrl(APP_INDEX_URL);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    public class AndroidBlobBridge {
        @JavascriptInterface
        public void saveDataUrl(String fileName, String mimeType, String dataUrl) {
            try {
                int commaIdx = dataUrl.indexOf(',');
                if (commaIdx < 0) return;
                String base64 = dataUrl.substring(commaIdx + 1);
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);

                String safeName = (fileName == null || fileName.trim().isEmpty())
                        ? "versend_" + System.currentTimeMillis()
                        : fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
                String safeMime = (mimeType == null || mimeType.trim().isEmpty())
                        ? "application/octet-stream"
                        : mimeType;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Versend");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri != null) {
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                            if (os != null) os.write(bytes);
                        }
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    File versendDir = new File(downloadsDir, "Versend");
                    if (!versendDir.exists()) versendDir.mkdirs();
                    File outFile = new File(versendDir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                    }
                }

                runOnUiThread(() ->
                        Toast.makeText(MainActivity.this, "Saved to Downloads/Versend/" + safeName, Toast.LENGTH_SHORT).show()
                );
            } catch (Exception e) {
                onSaveError(e.getMessage());
            }
        }

        @JavascriptInterface
        public void onSaveError(String message) {
            runOnUiThread(() ->
                    Toast.makeText(MainActivity.this, "Could not save file: " + message, Toast.LENGTH_LONG).show()
            );
        }
    }
}
