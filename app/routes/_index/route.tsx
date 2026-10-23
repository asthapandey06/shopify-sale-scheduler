import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

/**
 * Public landing page. Installs always start from the Shopify App Store or
 * admin (App Store requirement 2.3.1), so there is deliberately no
 * "enter your shop domain" form here.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

export default function Landing() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>PriceTide</h1>
        <p className={styles.text}>
          Schedule sales on products or collections that start and end on time, and put prices back the way they
          were when the sale is over.
        </p>
        <p className={styles.text}>Install it from the Shopify App Store, then open it from your Shopify admin.</p>
        <ul className={styles.list}>
          <li>
            <strong>Set it and forget it</strong>. Pick products or collections, a discount and a time window.
          </li>
          <li>
            <strong>Original prices restored</strong>. Prices and compare-at prices go back when the sale ends.
          </li>
          <li>
            <strong>Safe with your edits</strong>. Prices you change during a sale are left as you set them.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy policy</a>
        </p>
      </div>
    </div>
  );
}
