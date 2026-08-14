// resume-generator.js - AI-powered ATS-optimized resume generation
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { log } from './utils.js';
import { getAllSkills } from './profile-manager.js';

/**
 * Generate a tailored, ATS-optimized resume for a specific job
 */
export async function generateResume(profile, job) {
  log('info', `Generating tailored resume for: ${job.title} at ${job.company}`);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const allSkills = getAllSkills(profile);

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are an expert resume writer who creates ATS-optimized resumes. Generate a tailored resume for this specific job application.

CANDIDATE PROFILE:
Name: ${profile.personal?.name || 'N/A'}
Email: ${profile.personal?.email || 'N/A'}
Phone: ${profile.personal?.phone || 'N/A'}
Location: ${profile.personal?.location || 'N/A'}
LinkedIn: ${profile.personal?.linkedin || 'N/A'}
GitHub: ${profile.personal?.github || 'N/A'}
Portfolio: ${profile.personal?.portfolio || 'N/A'}

Summary: ${profile.summary || 'N/A'}

Experience:
${(profile.experience || []).map(e => `- ${e.title} at ${e.company} (${e.start_date} - ${e.end_date})
  ${e.description || ''}
  Achievements: ${(e.achievements || []).join('; ')}`).join('\n')}

Education:
${(profile.education || []).map(e => `- ${e.degree} from ${e.institution} (${e.graduation_date})`).join('\n')}

All Skills: ${allSkills.join(', ')}

Certifications:
${(profile.certifications || []).map(c => `- ${c.name} by ${c.issuer} (${c.date})`).join('\n') || 'None listed'}

Projects:
${(profile.projects || []).map(p => `- ${p.name}: ${p.description} [${(p.technologies || []).join(', ')}]`).join('\n') || 'None listed'}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${(job.description || '').substring(0, 3000)}

ATS OPTIMIZATION RULES:
1. Use standard section headers exactly: "Professional Summary", "Experience", "Education", "Skills", "Certifications", "Projects"
2. Include keywords from the job description verbatim
3. Use both acronyms AND full forms (e.g., "Amazon Web Services (AWS)")
4. Quantify achievements with numbers and metrics
5. Match job title terminology where truthful
6. NEVER fabricate experience, skills, or achievements — only reframe existing ones
7. Prioritize skills and experience most relevant to this specific job
8. Use action verbs: "Developed", "Implemented", "Led", "Optimized", "Designed"

Return ONLY valid JSON (no markdown fences):
{
  "professional_summary": "2-3 sentence tailored summary emphasizing relevant experience for this role",
  "experience": [
    {
      "title": "Job Title (adjusted to match job terminology if truthful)",
      "company": "Company Name",
      "location": "City, Country",
      "dates": "MMM YYYY - MMM YYYY",
      "bullets": [
        "Achievement-focused bullet point with metrics",
        "Another bullet emphasizing relevant skills"
      ]
    }
  ],
  "education": [
    {
      "degree": "Degree",
      "institution": "University",
      "date": "YYYY",
      "details": "GPA, honors, relevant coursework if applicable"
    }
  ],
  "skills": {
    "primary": ["Most relevant skills for this job"],
    "secondary": ["Other relevant skills"]
  },
  "certifications": [
    {"name": "Cert Name", "issuer": "Issuer", "date": "YYYY"}
  ],
  "projects": [
    {
      "name": "Project Name",
      "description": "Brief description emphasizing relevance to this job",
      "technologies": ["Tech 1"]
    }
  ]
}`
    }],
  });

  const text = response.content[0].text.trim();
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const resumeData = JSON.parse(jsonStr);

  // Attach personal info from profile (not AI-generated)
  resumeData.personal = profile.personal;

  log('info', `Resume generated for ${job.title} at ${job.company}`);
  return resumeData;
}
