package com.scoreturner.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.content.Intent;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // 冷启动（App 没在跑）时带着分享意图进来
    handleIntent(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    // App 已在后台运行，系统把分享送进来的情况
    handleIntent(intent);
  }

  private void handleIntent(Intent intent) {
    if (intent == null) return;
    String action = intent.getAction();
    if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
      // 把分享来的文件读成 base64 存入 ShareReceiverPlugin 的待处理队列，
      // 网页侧（js/modules/nativeShare.js）在启动或回到前台时通过 getPending() 取回。
      ShareReceiverPlugin.collectFromIntent(this, intent);
    }
  }
}
