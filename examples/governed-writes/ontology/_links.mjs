/**
 * Orangerail links (generated from Prisma relations).
 *
 * This file is yours — re-scans never modify it; `orangerail sync` reports drift.
 */
import { registry } from './_registry.mjs';
import { Article } from './Article.mjs';
import { Comment } from './Comment.mjs';

registry.defineLink({ name: "Article_comments", from: Article, to: Comment, cardinality: "many" });
