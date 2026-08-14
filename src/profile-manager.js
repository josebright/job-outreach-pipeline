// profile-manager.js - AI-powered resume parsing and profile management
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { cleanText, log } from './utils.js';

const execAsync = promisify(exec);

const PROFILE_PATH = path.join(config.dataDir, 'profile.json');

/**
 * Extract text from a PDF file using pdftotext
 */
async function extractPdfText(pdfPath) {
  try {
    const { stdout } = await execAsync(`pdftotext "${pdfPath}" -`);
    return cleanText(stdout || '');
  } catch (error) {
    log('warn', `pdftotext failed: ${error.message}. Trying fallback...`);
    try {
      const content = fs.readFileSync(pdfPath, 'utf8');
      return cleanText(content);
    } catch (fallbackError) {
      throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
  }
}

/**
 * Use Claude AI to parse resume text into structured profile data
 */
async function parseWithClaude(resumeText) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are an expert resume parser. Extract ALL information from this resume into a structured JSON format. Be thorough — capture every skill, every role, every project.

RESUME TEXT:
${resumeText}

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "personal": {
    "name": "Full Name",
    "email": "email@example.com",
    "phone": "+1234567890",
    "location": "City, Country",
    "linkedin": "linkedin.com/in/...",
    "github": "github.com/...",
    "portfolio": "website.com"
  },
  "summary": "2-3 sentence professional summary based on the resume content",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, Country",
      "start_date": "YYYY-MM",
      "end_date": "YYYY-MM or Present",
      "description": "Brief role description",
      "achievements": ["Achievement 1 with metrics if available", "Achievement 2"]
    }
  ],
  "education": [
    {
      "degree": "Degree Name",
      "institution": "University/School Name",
      "location": "City, Country",
      "graduation_date": "YYYY",
      "gpa": "if mentioned",
      "relevant_courses": ["Course 1"]
    }
  ],
  "skills": {
    "languages": ["JavaScript", "Python"],
    "frameworks": ["React", "Node.js"],
    "databases": ["PostgreSQL", "MongoDB"],
    "cloud": ["AWS", "Docker"],
    "tools": ["Git", "CI/CD"],
    "other": ["Agile", "System Design"]
  },
  "certifications": [
    {
      "name": "Certification Name",
      "issuer": "Issuing Organization",
      "date": "YYYY"
    }
  ],
  "projects": [
    {
      "name": "Project Name",
      "description": "What the project does",
      "technologies": ["Tech 1", "Tech 2"],
      "url": "project-url.com"
    }
  ],
  "languages_spoken": ["English"],
  "years_of_experience": 0
}

If a field is not found in the resume, use null for strings, empty arrays for arrays, and 0 for numbers. Calculate years_of_experience from the work history dates.`
    }],
  });

  const text = response.content[0].text.trim();

  // Try to parse JSON, handling potential markdown fences
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  return JSON.parse(jsonStr);
}

/**
 * Parse resume and create/update profile
 */
export async function setupProfile(resumePath) {
  log('info', `Parsing resume: ${resumePath}`);

  if (!fs.existsSync(resumePath)) {
    throw new Error(`Resume file not found: ${resumePath}`);
  }

  // Extract text from PDF
  const resumeText = await extractPdfText(resumePath);
  if (!resumeText || resumeText.length < 50) {
    throw new Error('Could not extract meaningful text from resume. Ensure the PDF contains selectable text.');
  }

  log('info', `Extracted ${resumeText.length} characters from resume`);

  // Use Claude to parse into structured profile
  log('info', 'Using Claude AI to parse resume...');
  const profile = await parseWithClaude(resumeText);

  // Add metadata
  profile._metadata = {
    source_file: path.resolve(resumePath),
    parsed_at: new Date().toISOString(),
    raw_text_length: resumeText.length,
  };

  // Ensure data directory exists
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  // Save profile
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  log('info', `Profile saved to ${PROFILE_PATH}`);

  // Print summary
  const skillCount = Object.values(profile.skills || {}).flat().length;
  log('info', `Profile summary:`);
  log('info', `  Name: ${profile.personal?.name || 'Not found'}`);
  log('info', `  Experience: ${profile.years_of_experience || 'Unknown'} years`);
  log('info', `  Roles: ${(profile.experience || []).length}`);
  log('info', `  Skills: ${skillCount}`);
  log('info', `  Education: ${(profile.education || []).length}`);
  log('info', `  Projects: ${(profile.projects || []).length}`);

  return profile;
}

/**
 * Load existing profile from disk
 */
export function loadProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error('Profile not found. Run "node src/index.js setup --resume resume.pdf" first.');
  }

  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  log('info', `Loaded profile for ${profile.personal?.name || 'Unknown'}`);
  return profile;
}

/**
 * Check if profile exists
 */
export function profileExists() {
  return fs.existsSync(PROFILE_PATH);
}

/**
 * Get a flat list of all skills from the profile
 */
export function getAllSkills(profile) {
  if (!profile?.skills) return [];
  return [...new Set(Object.values(profile.skills).flat().filter(Boolean))];
}

/**
 * Get a concise text summary of the profile for AI matching
 */
export function getProfileSummary(profile) {
  const skills = getAllSkills(profile);
  const experience = (profile.experience || [])
    .map(e => `${e.title} at ${e.company} (${e.start_date} - ${e.end_date})`)
    .join('; ');

  return [
    `Name: ${profile.personal?.name || 'N/A'}`,
    `Summary: ${profile.summary || 'N/A'}`,
    `Years of Experience: ${profile.years_of_experience || 'N/A'}`,
    `Skills: ${skills.join(', ')}`,
    `Experience: ${experience}`,
    `Education: ${(profile.education || []).map(e => `${e.degree} from ${e.institution}`).join('; ')}`,
  ].join('\n');
}
