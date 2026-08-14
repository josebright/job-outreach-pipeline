// ai-matcher.js - AI-powered job matching using Claude API
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { log } from './utils.js';
import { getProfileSummary } from './profile-manager.js';

const BATCH_SIZE = 5; // Jobs per Claude API call

/**
 * Score a batch of jobs against the user profile using Claude
 */
async function scoreBatch(client, profileSummary, jobs) {
  const jobDescriptions = jobs.map((job, i) => {
    return `--- JOB ${i + 1} ---
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Remote: ${job.remote ? 'Yes' : 'No'}
Sponsorship mentioned: ${job.sponsorship_mentioned ? 'Yes' : 'No'}
Description: ${(job.description || '').substring(0, 1500)}
---`;
  }).join('\n\n');

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an expert technical recruiter evaluating job-candidate fit. Score how qualified the candidate is for each job.

CANDIDATE PROFILE:
${profileSummary}

IMPORTANT CONTEXT: The candidate is a Nigerian seeking remote positions or roles with visa sponsorship in the US, UK, Canada, Australia, or Europe.

JOBS TO EVALUATE:
${jobDescriptions}

For each job, provide a qualification score from 0-100 where:
- 95-100: Candidate exceeds all requirements, perfect match
- 85-94: Candidate meets almost all requirements, strong match
- 70-84: Good match but missing some requirements
- 50-69: Partial match, significant gaps
- Below 50: Poor match

Be STRICT and realistic. Only score 95+ if the candidate truly has all required skills, sufficient experience level, and the role is accessible (remote or sponsorship available).

Consider:
1. Skills match: Does the candidate have the required technical skills?
2. Experience level: Does seniority align (junior vs senior)?
3. Domain fit: Is the candidate's background relevant?
4. Accessibility: Can a Nigerian actually apply (remote/visa/sponsorship)?

Return ONLY valid JSON (no markdown fences):
[
  {"job_index": 1, "score": 85, "reasoning": "Brief explanation", "missing_skills": ["skill1"], "strong_matches": ["skill1"]},
  ...
]`
    }],
  });

  const text = response.content[0].text.trim();
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  return JSON.parse(jsonStr);
}

/**
 * Match all jobs against the profile using Claude AI
 * Returns only jobs scoring >= minScore
 */
export async function matchJobs(profile, jobs, options = {}) {
  const { minScore = config.search.minMatchScore } = options;

  if (!jobs || jobs.length === 0) {
    log('info', 'No jobs to match');
    return [];
  }

  log('info', `AI matching ${jobs.length} jobs (threshold: ${minScore}%)...`);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const profileSummary = getProfileSummary(profile);
  const matchedJobs = [];

  // Process in batches
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(jobs.length / BATCH_SIZE);

    log('info', `Scoring batch ${batchNum}/${totalBatches} (${batch.length} jobs)...`);

    try {
      const scores = await scoreBatch(client, profileSummary, batch);

      for (const result of scores) {
        const jobIndex = result.job_index - 1;
        if (jobIndex >= 0 && jobIndex < batch.length && result.score >= minScore) {
          matchedJobs.push({
            ...batch[jobIndex],
            match_score: result.score,
            match_reasoning: result.reasoning,
            missing_skills: result.missing_skills || [],
            strong_matches: result.strong_matches || [],
            matched_at: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      log('error', `Error scoring batch ${batchNum}: ${error.message}`);
    }
  }

  // Sort by score (highest first)
  matchedJobs.sort((a, b) => b.match_score - a.match_score);

  log('info', `AI matching complete: ${matchedJobs.length}/${jobs.length} jobs scored ${minScore}%+`);

  return matchedJobs;
}
