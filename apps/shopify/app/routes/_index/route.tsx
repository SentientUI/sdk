import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import styles from "./styles.module.css";

// The public root, seen outside the embedded admin (app-store listing clicks,
// health checkers, the curious). Marketing copy only — the template's
// shop-domain login form is deliberately GONE: App Store requirement 2.3.1
// forbids asking anyone to type a .myshopify.com domain, and installs always
// start from a Shopify surface, so the form had no legitimate caller. A visit
// with ?shop= (how Shopify links in) still routes into OAuth.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SentientUI for Shopify</h1>
        <p className={styles.text}>
          Connects your store&rsquo;s orders and refunds to SentientUI, so your
          revenue goals and experiments are credited with the sales they
          actually made.
        </p>
        <p className={styles.text}>
          Install the app from the Shopify App Store, then paste your project
          keys on its settings screen.
        </p>
        <p className={styles.text}>
          New here?{" "}
          <a href="https://sentient-ui.com" target="_blank" rel="noreferrer">
            Learn more about SentientUI
          </a>
          .
        </p>
      </div>
    </div>
  );
}
