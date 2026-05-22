import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// List is parametric on status — invalidation must use the prefix form
// (`{ queryKey: ["survey-questions"] }`) to clear all status partitions,
// not the exact-match form (which would only hit one status).
export const surveyQuestionsListQuery = (status: "active" | "archived" | "all" = "active") =>
  queryOptions({
    queryKey: ["survey-questions", status] as const,
    queryFn: () => client.surveyQuestions.list({ status }),
  });

export const surveyQuestionDetailQuery = (surveyQuestionId: string) =>
  queryOptions({
    queryKey: ["survey-question", surveyQuestionId] as const,
    queryFn: () => client.surveyQuestions.getById({ surveyQuestionId }),
  });

// Seed the detail cache for a freshly-created question with an empty
// options array — the shape an edit-modal expects. Centralizes the
// empty-options invariant. Only use this right after `surveyQuestions.create`;
// never seed from a list-row projection (that's missing options).
export function seedQuestionDetail(
  queryClient: QueryClient,
  question: Awaited<ReturnType<typeof client.surveyQuestions.create>>,
): void {
  queryClient.setQueryData(["survey-question", question.surveyQuestionId], {
    ...question,
    options: [],
  });
}
