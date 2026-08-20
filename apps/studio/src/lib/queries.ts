/**
 * Query keys and hooks.
 *
 * Keys follow UI §4.1's convention — one key per entity, one index key per collection — so
 * invalidation is predictable rather than folklore. The editor's `['version', id, 'tree']`
 * patching strategy lands in P1-03; the lists here are small enough to invalidate wholesale.
 */

'use client';

import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch, newIdempotencyKey, type PageEnvelope } from '@/lib/api-client';
import type {
  InvitationView,
  JobView,
  MemberView,
  OrgListView,
  OrgRole,
  ProjectView,
  SurveyDetailView,
  SurveyView,
} from '@/lib/api-types';

export const queryKeys = {
  orgs: ['orgs'] as const,
  members: (orgId: string) => ['org', orgId, 'members'] as const,
  invitations: (orgId: string) => ['org', orgId, 'invitations'] as const,
  projects: (orgId: string) => ['org', orgId, 'projects'] as const,
  project: (projectId: string) => ['project', projectId] as const,
  surveys: (orgId: string, projectId?: string) =>
    projectId === undefined
      ? (['org', orgId, 'surveys'] as const)
      : (['org', orgId, 'surveys', projectId] as const),
  survey: (surveyId: string) => ['survey', surveyId] as const,
  job: (jobId: string) => ['job', jobId] as const,
};

export function useOrgs(): UseQueryResult<OrgListView> {
  return useQuery({
    queryKey: queryKeys.orgs,
    queryFn: async () => (await apiFetch<OrgListView>('/organizations')).data,
  });
}

export function useMembers(orgId: string | null): UseQueryResult<PageEnvelope<MemberView>> {
  return useQuery({
    queryKey: queryKeys.members(orgId ?? 'none'),
    enabled: orgId !== null,
    queryFn: async () =>
      (await apiFetch<PageEnvelope<MemberView>>('/organizations/' + orgId + '/members')).data,
  });
}

export function useUpdateMemberRole(
  orgId: string | null,
): UseMutationResult<MemberView, Error, { userId: string; role: OrgRole }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }) =>
      (
        await apiFetch<MemberView>('/members/' + userId, {
          method: 'PATCH',
          body: { role },
        })
      ).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.members(orgId ?? 'none') });
    },
  });
}

export function useRemoveMember(orgId: string | null): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await apiFetch<void>('/members/' + userId, { method: 'DELETE' });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.members(orgId ?? 'none') });
    },
  });
}

export function useInvitations(orgId: string | null): UseQueryResult<PageEnvelope<InvitationView>> {
  return useQuery({
    queryKey: queryKeys.invitations(orgId ?? 'none'),
    enabled: orgId !== null,
    queryFn: async () => (await apiFetch<PageEnvelope<InvitationView>>('/invitations')).data,
  });
}

export function useCreateInvitation(
  orgId: string | null,
): UseMutationResult<InvitationView, Error, { email: string; role: OrgRole }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (
        await apiFetch<InvitationView>('/invitations', {
          method: 'POST',
          body,
          // Double-submitting an invite must not send two emails with two live tokens.
          idempotencyKey: newIdempotencyKey(),
        })
      ).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.invitations(orgId ?? 'none') });
    },
  });
}

export function useProjects(orgId: string | null): UseQueryResult<PageEnvelope<ProjectView>> {
  return useQuery({
    queryKey: queryKeys.projects(orgId ?? 'none'),
    enabled: orgId !== null,
    queryFn: async () => (await apiFetch<PageEnvelope<ProjectView>>('/projects')).data,
  });
}

export function useCreateProject(
  orgId: string | null,
): UseMutationResult<ProjectView, Error, { ref: string; name: string; client_name?: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (await apiFetch<ProjectView>('/projects', { method: 'POST', body, idempotencyKey: newIdempotencyKey() })).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.projects(orgId ?? 'none') });
    },
  });
}

export function useSurveys(
  orgId: string | null,
  projectId?: string,
): UseQueryResult<PageEnvelope<SurveyView>> {
  return useQuery({
    queryKey: queryKeys.surveys(orgId ?? 'none', projectId),
    enabled: orgId !== null,
    queryFn: async () =>
      (
        await apiFetch<PageEnvelope<SurveyView>>(
          '/surveys' + (projectId === undefined ? '' : '?project_id=' + projectId),
        )
      ).data,
  });
}

export function useSurvey(surveyId: string): UseQueryResult<SurveyDetailView> {
  return useQuery({
    queryKey: queryKeys.survey(surveyId),
    queryFn: async () => (await apiFetch<SurveyDetailView>('/surveys/' + surveyId)).data,
  });
}

export function useCreateSurvey(
  orgId: string | null,
  projectId: string,
): UseMutationResult<{ survey: SurveyView }, Error, { ref: string; name: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (
        await apiFetch<{ survey: SurveyView }>('/surveys', {
          method: 'POST',
          body: { ...body, project_id: projectId },
          idempotencyKey: newIdempotencyKey(),
        })
      ).data,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.surveys(orgId ?? 'none') });
      void client.invalidateQueries({ queryKey: queryKeys.surveys(orgId ?? 'none', projectId) });
    },
  });
}

export function useUpdateSurvey(
  orgId: string | null,
): UseMutationResult<SurveyView, Error, { id: string; name?: string; archived?: boolean }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await apiFetch<SurveyView>('/surveys/' + id, { method: 'PATCH', body })).data,
    onSuccess: (survey) => {
      void client.invalidateQueries({ queryKey: queryKeys.surveys(orgId ?? 'none') });
      void client.invalidateQueries({ queryKey: queryKeys.survey(survey.id) });
    },
  });
}

export function useSwitchOrg(): UseMutationResult<{ org_id: string }, Error, string> {
  return useMutation({
    mutationFn: async (orgId: string) =>
      (await apiFetch<{ org_id: string }>('/orgs/' + orgId + '/switch', { method: 'POST' })).data,
  });
}

/**
 * Job polling. `refetchInterval` mirrors API §4's guidance (2 s, and the endpoint is exempt
 * from the standard rate limit up to 1 req/s per job); it stops at a terminal status so a
 * finished job is not polled forever by a tab someone left open.
 */
export function useJob(jobId: string | null): UseQueryResult<JobView> {
  return useQuery({
    queryKey: queryKeys.job(jobId ?? 'none'),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 2000 : false;
    },
    queryFn: async () => (await apiFetch<JobView>('/jobs/' + jobId)).data,
  });
}
