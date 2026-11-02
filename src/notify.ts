import { EventEmitter } from "node:events";
import webpush from "web-push";
import { type Db, getSetting, setSetting } from "./db.js";

export interface WalletEvent {
  type: string;
  message: string;
  agentId?: string;
  requestId?: string;
}

/** Fans wallet events out to open approval-app tabs (SSE) and to phones (web push). */
export class Notifier {
  readonly bus = new EventEmitter();
  readonly vapidPublicKey: string;
  private readonly pushEnabled: boolean;
  private readonly vapid: { subject: string; publicKey: string; privateKey: string };
  /** Where this wallet's routes live, for notification buttons (empty, or /t/<account> when hosted). */
  private readonly basePath: string;

  constructor(
    private readonly db: Db,
    opts: { subject?: string; publicUrl?: string; enablePush?: boolean; basePath?: string } = {},
  ) {
    this.bus.setMaxListeners(100);
    let pub = getSetting(db, "vapid_public");
    let priv = getSetting(db, "vapid_private");
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      setSetting(db, "vapid_public", pub);
      setSetting(db, "vapid_private", priv);
    }
    this.vapidPublicKey = pub;
    this.pushEnabled = opts.enablePush ?? true;
    this.basePath = opts.basePath ?? "";
    // Passed per send, not set globally, so several wallets can share one process.
    this.vapid = { subject: opts.subject ?? "mailto:admin@example.com", publicKey: pub, privateKey: priv };
  }

  emit(event: WalletEvent): void {
    this.bus.emit("event", event);
  }

  saveSubscription(sub: { endpoint: string }): void {
    this.db
      .prepare(
        "INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription",
      )
      .run(sub.endpoint, JSON.stringify(sub), new Date().toISOString());
  }

  async push(payload: {
    title: string;
    body: string;
    requestId?: string;
    /** Lets the phone approve or deny straight from the notification. */
    quickToken?: string;
  }): Promise<void> {
    if (!this.pushEnabled) return;
    const rows = this.db.prepare("SELECT endpoint, subscription FROM push_subscriptions").all() as {
      endpoint: string;
      subscription: string;
    }[];
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify({ ...payload, base: this.basePath }), {
            vapidDetails: this.vapid,
          });
        } catch (err: any) {
          // 404/410 means the phone unsubscribed; forget it.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(row.endpoint);
          } else {
            console.error("Push failed:", err?.message ?? err);
          }
        }
      }),
    );
  }
}
