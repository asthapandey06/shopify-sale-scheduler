import { useLoaderData } from "react-router";
import { config } from "../config.server";

/**
 * Public privacy policy. Use https://<your-app-url>/privacy as the
 * "Privacy policy URL" in the App Store listing.
 */
export const loader = async () => ({
  supportEmail: config.supportEmail,
  ownerName: config.ownerName,
  appUrl: config.appUrl,
});

export const meta = () => [{ title: "Privacy policy — PriceTide" }];

const s = {
  main: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 720,
    margin: "48px auto",
    padding: "0 16px",
    color: "#303030",
    lineHeight: 1.6,
  },
  h2: { fontSize: 18, marginTop: 28 },
};

export default function Privacy() {
  const { supportEmail, ownerName } = useLoaderData<typeof loader>();
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : "the support email in the app listing";

  return (
    <main style={s.main}>
      <h1>Privacy policy — PriceTide</h1>
      <p>Last updated: October 21, 2026</p>
      <p>
        PriceTide (&quot;the app&quot;) is provided by {ownerName}. This policy explains what the app collects when a
        merchant installs it on a Shopify store, and how that information is used.
      </p>

      <h2 style={s.h2}>Information we collect</h2>
      <ul>
        <li>Your store&apos;s Shopify domain and the access token Shopify issues when you install the app.</li>
        <li>The sales you create: name, discount, schedule and the products or collections you choose.</li>
        <li>
          For each product variant in a running sale: its price and compare-at price before and during the sale, so the
          originals can be restored.
        </li>
        <li>A log of actions taken on your sales (created, started, ended) for support.</li>
      </ul>
      <p>
        The app does not access or store any information about your customers or your orders. Its only Shopify
        permission is to read and update products.
      </p>

      <h2 style={s.h2}>How we use it</h2>
      <p>
        Only to run the app: to change prices when a sale starts, restore them when it ends, show you the status of
        your sales, and bill your subscription through Shopify. We do not sell, rent or share this information, and we
        do not use it for advertising.
      </p>

      <h2 style={s.h2}>Storage and security</h2>
      <p>
        Data is stored in an encrypted-in-transit database hosted by our infrastructure provider. Shopify access tokens
        are additionally encrypted at rest. Access is limited to what is needed to operate and support the app.
      </p>

      <h2 style={s.h2}>Retention and deletion</h2>
      <p>
        When you uninstall the app, Shopify revokes its access immediately. Shopify then asks us to erase your store&apos;s
        data 48 hours later, and we delete everything we hold for your store at that point; if that request never
        arrives, we delete it 30 days after uninstall. Deleted data can&apos;t be retrieved. Before uninstalling you
        can, on the app&apos;s Plan page, pause the app to keep your data and resume later, or permanently delete
        all your sales and their history. You can also delete individual finished sales at any time.
      </p>

      <h2 style={s.h2}>Your rights</h2>
      <p>
        You can ask us for a copy of the data we hold about your store, or ask us to delete it, by contacting {contact}.
        If you are located in the EU, UK or another region with data-protection laws, you may also have the right to
        complain to your local data-protection authority.
      </p>

      <h2 style={s.h2}>Changes</h2>
      <p>We will update this page if this policy changes, and change the date above.</p>

      <h2 style={s.h2}>Contact</h2>
      <p>Questions about privacy: {contact}.</p>
    </main>
  );
}
