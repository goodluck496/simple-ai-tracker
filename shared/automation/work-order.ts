import type { AgentRole, AgentVerdict } from './contracts.js';

export interface WorkStep { id: string; kind: 'context' | 'step'; text: string; }
export interface WorkProgress { state: 'hints' | 'stale' | 'unreadable'; completedSteps?: string[]; nextStep?: string; summary?: string; }
export interface StageEvidence {
  stage: number; revision: number; role: AgentRole; sha: string; requirementsKey: string;
  verdict: AgentVerdict; summary: string; changedFiles: string[];
  checks: { command: string; args: string[]; exitCode: 0 }[];
  current?: boolean;
}

/** A lossless view of the approved plan, not another model-generated summary. */
export class WorkOrder {
  public static from(plan: unknown): { version?: number; steps: WorkStep[] } | undefined {
    if (!plan) return undefined;
    const value = typeof plan === 'string' ? { content: plan } : plan as { content?: unknown; version?: number };
    if (typeof value.content !== 'string') throw new Error('Approved plan has no readable content.');
    const steps: WorkStep[] = []; let number = 0;
    for (const line of value.content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const startsStep = /^\s*\d+[.)]\s+/.test(line);
      const startsSection = /^#{1,6}\s/.test(line);
      if (!steps.length || startsStep || startsSection) {
        steps.push({ id: startsStep ? `S${++number}` : `C${steps.length + 1}`, kind: startsStep ? 'step' : 'context', text: line });
      } else steps[steps.length - 1].text += line;
    }
    return { version: value.version, steps: number || !value.content ? steps : [{ id: 'S1', kind: 'step', text: value.content }] };
  }
}
