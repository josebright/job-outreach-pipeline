// cover-letter-generator.js - AI-powered cover letter generation
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { log } from './utils.js';

/**
 * Generate a personalized cover letter for a specific job application
 */
export async function generateCoverLetter(profile, job) {
  log('info', `Generating cover letter for: ${job.title} at ${job.company}`);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an expert career coach who writes compelling, personalized cover letters that win interviews. Write a cover letter for this job application.

CANDIDATE:
Name: ${profile.personal?.name || 'N/A'}
Email: ${profile.personal?.email || 'N/A'}
Phone: ${profile.personal?.phone || 'N/A'}
Location: ${profile.personal?.location || 'N/A'}

Professional Summary: ${profile.summary || 'N/A'}

Key Experience:
${(profile.experience || []).slice(0, 3).map(e => `- ${e.title} at ${e.company}: ${e.description || ''}\n  Key achievements: ${(e.achievements || []).slice(0, 2).join('; ')}`).join('\n')}

Top Skills: ${Object.values(profile.skills || {}).flat().slice(0, 20).join(', ')}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${(job.description || '').substring(0, 3000)}

COVER LETTER REQUIREMENTS:
1. Maximum 400 words — concise and impactful
2. Address the hiring manager (use "Dear Hiring Manager" if name unknown)
3. Opening paragraph: Hook with enthusiasm + mention the specific role
4. Body paragraph 1: Most relevant experience and achievements that map to job requirements
5. Body paragraph 2: Technical skills and how they solve the company's challenges
6. Closing paragraph: Express eagerness, mention availability, call to action
7. Professional but personable tone — show personality
8. Reference specific requirements from the job description
9. NEVER fabricate experience or skills
10. If the role is remote or requires relocation, mention willingness and readiness

Return ONLY valid JSON (no markdown fences):
{
  "greeting": "Dear Hiring Manager,",
  "opening": "First paragraph text...",
  "body_1": "Second paragraph about experience...",
  "body_2": "Third paragraph about technical skills...",
  "closing": "Closing paragraph...",
  "sign_off": "Sincerely,",
  "full_text": "The complete cover letter as a single formatted text with proper paragraphs"
}`
    }],
  });

  const text = response.content[0].text.trim();
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const coverLetter = JSON.parse(jsonStr);
  coverLetter.applicant_name = profile.personal?.name || '';
  coverLetter.applicant_email = profile.personal?.email || '';
  coverLetter.applicant_phone = profile.personal?.phone || '';
  coverLetter.job_title = job.title;
  coverLetter.company = job.company;
  coverLetter.generated_at = new Date().toISOString();

  log('info', `Cover letter generated for ${job.title} at ${job.company}`);
  return coverLetter;
}
