import type { AgentRole } from './contracts.js';

export interface SkillBinding { skillId: string; roles: AgentRole[]; }
export interface SkillReference { id: string; version: number; }
export interface SkillSummary extends SkillReference { name: string; description: string; }
export interface LibrarySkill extends SkillSummary { content: string; sourceUrl?: string; }
