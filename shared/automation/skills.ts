import type { AgentRole } from './contracts.js';

export const SKILL_LIMITS = { name: 100, description: 8000, content: 128000, promptDescription: 320, readChunk: 16000 } as const;

export interface SkillBinding { skillId: string; roles: AgentRole[]; }
export interface SkillReference { id: string; version: number; }
export interface SkillSummary extends SkillReference { name: string; description: string; }
export interface LibrarySkill extends SkillSummary { content: string; sourceUrl?: string; }
