import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

// The public root, seen outside the embedded admin (app-store listing clicks,
// health checkers, the curious). It shipped for months with the template's
// "[your app]" placeholder copy — say what the connector actually does
// instead, in plain merchant language, and keep the template's shop-domain
// login form as the way in.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SentientUI for Shopify</h1>
        <p className={styles.text}>
          Connects your store&rsquo;s orders and refunds to SentientUI, so your
          revenue goals and experiments are credited with the sales they
          actually made.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
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
