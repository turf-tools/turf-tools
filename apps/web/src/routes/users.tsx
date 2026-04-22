import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/users")({
  component: UsersPage,
});

function UsersPage() {
  return (
    <>
      <h1 className="mb-4 text-xl font-extrabold tracking-wide">Users</h1>
      <p className="text-muted-foreground">User management will live here.</p>
    </>
  );
}
