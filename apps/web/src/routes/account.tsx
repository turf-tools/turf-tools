import { createFileRoute } from "@tanstack/react-router";
import { Page } from "~/components/page";

export const Route = createFileRoute("/account")({
  component: AccountPage,
});

function AccountPage() {
  return (
    <Page>
      <h1 className="mb-4 text-xl font-extrabold tracking-wide">Account</h1>
      <p className="text-muted-foreground">Account settings will live here.</p>
    </Page>
  );
}
