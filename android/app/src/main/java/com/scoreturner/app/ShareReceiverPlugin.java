package com.scoreturner.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;

import android.content.Context;
import android.content.Intent;
import android.content.ClipData;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

/**
 * 接收系统"分享/打开方式"送来的文件（来自 B站 / 微信 / 文件管理器）。
 * MainActivity 在 onCreate / onNewIntent 里把 Intent 交给 collectFromIntent()，
 * 这里把每个 Uri 读成字节并 base64 化，存入静态 pending，供网页层通过
 * getPending() 取回（再由 js/modules/nativeShare.js 交给 ScoreLoader 导入）。
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {

  private static String pendingJson = null;

  public static void collectFromIntent(Context ctx, Intent intent) {
    try {
      ArrayList<Uri> uris = new ArrayList<>();
      if (Intent.ACTION_SEND.equals(intent.getAction())) {
        Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u != null) uris.add(u);
      } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
        ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (list != null) uris.addAll(list);
      }
      if (uris.isEmpty() && intent.getClipData() != null) {
        ClipData cd = intent.getClipData();
        for (int i = 0; i < cd.getItemCount(); i++) {
          Uri u = cd.getItemAt(i).getUri();
          if (u != null) uris.add(u);
        }
      }

      JSONArray arr = new JSONArray();
      for (Uri u : uris) {
        byte[] bytes = readBytes(ctx, u);
        if (bytes == null) continue;
        String name = getName(ctx, u);
        String mime = intent.getType();
        if (mime == null) mime = ctx.getContentResolver().getType(u);
        if (mime == null) mime = "application/octet-stream";
        String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
        JSONObject o = new JSONObject();
        o.put("name", name);
        o.put("mime", mime);
        o.put("size", bytes.length);
        o.put("data", "data:" + mime + ";base64," + b64);
        arr.put(o);
      }
      if (arr.length() > 0) pendingJson = arr.toString();
    } catch (Exception e) {
      // 解析失败不应让 App 崩，清空即可
      pendingJson = null;
    }
  }

  private static byte[] readBytes(Context ctx, Uri uri) {
    try {
      InputStream is = ctx.getContentResolver().openInputStream(uri);
      if (is == null) return null;
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      int n;
      while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
      is.close();
      return bos.toByteArray();
    } catch (Exception e) {
      return null;
    }
  }

  private static String getName(Context ctx, Uri uri) {
    String res = "shared-score";
    try {
      Cursor c = ctx.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
      if (c != null) {
        if (c.moveToFirst()) {
          int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
          if (i >= 0) res = c.getString(i);
        }
        c.close();
      }
    } catch (Exception e) { /* 忽略 */ }
    if (res == null || res.isEmpty()) res = uri.getLastPathSegment();
    return res == null ? "shared-score" : res;
  }

  /** 网页层调用：取回并清空待处理文件列表 */
  @PluginMethod
  public void getPending(PluginCall call) {
    String p = pendingJson;
    pendingJson = null;
    JSONArray arr;
    try {
      arr = new JSONArray(p == null ? "[]" : p);
    } catch (Exception e) {
      arr = new JSONArray();
    }
    JSObject ret = new JSObject();
    try {
      ret.put("files", new JSArray(arr.toString()));
    } catch (Exception e) {
      ret.put("files", new JSArray("[]"));
    }
    call.resolve(ret);
  }
}
