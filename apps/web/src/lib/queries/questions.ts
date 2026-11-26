import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// List is parametric on status — invalidation must use the prefix form
// (`{ queryKey: ["questions"] }`) to clear all status partitions,
// not the exact-match form (which would only hit one status).
export const questionsListQuery = (status: "active" | "archived" | "all" = "active") =>
  queryOptions({
    queryKey: ["questions", status] as const,
    queryFn: () => client.questions.list({ status }),
  });

// Active questions with options inlined (canvass-response filter editor).
// Keyed under the `["questions"]` prefix so the question/option mutations'
// prefix-form invalidations clear it.
export const questionsWithOptionsQuery = () =>
  queryOptions({
    queryKey: ["questions", "with-options"] as const,
    queryFn: () => client.questions.listWithOptions(),
  });

export const questionDetailQuery = (questionId: string) =>
  queryOptions({
    queryKey: ["question", questionId] as const,
    queryFn: () => client.questions.getById({ questionId }),
  });

// Seed the detail cache for a freshly-created question with an empty
// options array — the shape an edit-modal expects. Centralizes the
// empty-options invariant. Only use this right after `questions.create`;
// never seed from a list-row projection (that's missing options).
export function seedQuestionDetail(
  queryClient: QueryClient,
  question: Awaited<ReturnType<typeof client.questions.create>>,
): void {
  queryClient.setQueryData(["question", question.questionId], {
    ...question,
    lockedBy: [],
    options: [],
  });
}

export type QuestionLock = Awaited<ReturnType<typeof client.scripts.lock>>["questions"][number];

// Writes question lock state returned by a script lock/unlock into the detail
// and list caches. A question is locked while any locked script contains it.
export function patchQuestionLocks(queryClient: QueryClient, locks: QuestionLock[]) {
  const byId = new Map(locks.map((l) => [l.questionId, l.lockedBy]));
  for (const l of locks) {
    queryClient.setQueryData<{ lockedBy: QuestionLock["lockedBy"] }>(
      ["question", l.questionId],
      (old) => (old ? { ...old, lockedBy: l.lockedBy } : old),
    );
  }
  for (const status of ["active", "archived", "all"] as const) {
    queryClient.setQueryData(questionsListQuery(status).queryKey, (old) =>
      old?.map((q) => {
        const lockedBy = byId.get(q.questionId);
        return lockedBy === undefined ? q : { ...q, lockedBy };
      }),
    );
  }
}

export const questionLockKeys = (locks: QuestionLock[]) => [
  ["questions"],
  ...locks.map((l) => ["question", l.questionId]),
];
