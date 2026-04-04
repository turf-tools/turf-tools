import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { client } from "../rpc/client";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { data, isLoading } = useQuery({
    queryKey: ["healthcheck"],
    queryFn: () => client.healthcheck(),
  });

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="mb-8 text-4xl font-bold">Turf</h1>
        <p className="text-md text-muted-foreground">
          RPC status: <span className="font-mono">{isLoading ? "loading..." : data?.status}</span>
        </p>
        <p className="mb-8 text-md text-muted-foreground">
          DB status: <span className="font-mono">{isLoading ? "loading..." : data?.db}</span>
        </p>
        <div className="flex gap-3 justify-center">
          <Button>Button</Button>
        </div>
      </div>
    </div>
  );
}
