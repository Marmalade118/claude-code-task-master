/**
 * src/ai-providers/claude-code.js
 *
 * Implementation for using local Claude Code CLI instead of the Anthropic API.
 * This provider enables Task Master to use the locally installed Claude Code
 * instead of requiring a separate API key.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../../scripts/modules/utils.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Get the path to the Claude Code CLI, defaulting to global installation path.
 * @returns {string} The path to the Claude Code executable
 */
function getClaudeCodePath() {
  // Define common installation paths
  const possiblePaths = [
    // Path when installed globally with npm
    '/usr/local/bin/claude',
    // Path for specific user installations
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), 'node_modules/.bin/claude'),
    // Default to just the command name, relying on PATH
    'claude'
  ];

  // Try to find the executable
  for (const possiblePath of possiblePaths) {
    try {
      if (fs.existsSync(possiblePath)) {
        return possiblePath;
      }
    } catch (error) {
      // Skip if checking existence fails
      continue;
    }
  }

  // Default to command name if we can't find it
  return 'claude';
}

/**
 * Generate text using local Claude Code CLI.
 *
 * @param {object} params - Parameters for text generation
 * @param {Array<object>} params.messages - The messages array
 * @param {number} [params.maxTokens] - Maximum tokens for response
 * @param {number} [params.temperature] - Temperature for generation
 * @returns {Promise<string>} The generated text
 */
export async function generateClaudeCodeText({
  messages,
  maxTokens,
  temperature
}) {
  log('debug', 'Generating text with local Claude Code CLI');
  
  // Check if we have a system message and a user message
  const systemMessage = messages.find(msg => msg.role === 'system')?.content || '';
  const userMessages = messages.filter(msg => msg.role === 'user');
  
  if (userMessages.length === 0) {
    throw new Error('At least one user message is required');
  }
  
  // Get the most recent user message
  const userMessage = userMessages[userMessages.length - 1].content;
  
  // Combine system message and user message
  const promptContent = systemMessage ? `${systemMessage}\n\n${userMessage}` : userMessage;
  
  // Prepare Claude Code CLI command
  const claudeCodePath = getClaudeCodePath();
  // Use --print for non-interactive output and specify model
  // For text generation, use text format; for objects, we'll use a separate approach
  const args = ['--print', '--model', 'sonnet'];
  
  // Execute Claude Code CLI
  return new Promise((resolve, reject) => {
    const claudeProcess = spawn(claudeCodePath, args, { stdio: 'pipe' });
    
    let stdout = '';
    let stderr = '';
    
    // Write the prompt to stdin
    claudeProcess.stdin.write(promptContent);
    claudeProcess.stdin.end();
    
    claudeProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    claudeProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    claudeProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude Code CLI failed with code ${code}: ${stderr}`));
      }
    });
    
    claudeProcess.on('error', (error) => {
      reject(new Error(`Failed to execute Claude Code CLI: ${error.message}`));
    });
  });
}

/**
 * Streams text from Claude Code CLI by streaming stdout.
 * Currently not supported in a true streaming fashion -
 * we wait for full completion then return all at once.
 *
 * @param {object} params - Parameters for text streaming
 * @param {Array<object>} params.messages - The messages array
 * @param {number} [params.maxTokens] - Maximum tokens for response
 * @param {number} [params.temperature] - Temperature for generation
 * @returns {Promise<object>} The stream result object
 */
export async function streamClaudeCodeText(params) {
  // For now, we're implementing this as a non-streaming function
  // that returns in the format expected by the caller
  const text = await generateClaudeCodeText(params);
  
  return {
    textStream: new ReadableStream({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      }
    }),
    text: text,
    usage: {
      promptTokens: 0,  // We don't have token counts from Claude Code CLI
      completionTokens: 0
    }
  };
}

/**
 * Generates a structured object using Claude Code CLI.
 * Uses a JSON extraction technique to generate structured output.
 *
 * @param {object} params - Parameters for object generation
 * @param {Array<object>} params.messages - The messages array
 * @param {import('zod').ZodSchema} params.schema - Zod schema for the object
 * @param {string} params.objectName - Name for the object/tool
 * @param {number} [params.maxTokens] - Maximum tokens for response
 * @param {number} [params.temperature] - Temperature for generation
 * @param {number} [params.maxRetries] - Max retries for validation
 * @returns {Promise<object>} The generated object matching the schema
 */
export async function generateClaudeCodeObject({
  messages,
  schema,
  objectName = 'generated_object',
  maxTokens,
  temperature,
  maxRetries = 3
}) {
  log('debug', `Generating object '${objectName}' with Claude Code CLI`);
  
  // Prepare a modified system prompt that instructs Claude to output JSON
  let systemPrompt = messages.find(msg => msg.role === 'system')?.content || '';
  systemPrompt += `\n\nIMPORTANT: Your response must be ONLY valid JSON that matches this schema: ${JSON.stringify(schema._def.shape())}.\n`;
  systemPrompt += `The response should be a single valid JSON object for ${objectName} with no other text, no markdown code blocks, no explanations.`;
  
  // Create a modified messages array with our JSON-specific system prompt
  const jsonMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.filter(msg => msg.role !== 'system')
  ];
  
  // Track retries
  let attempts = 0;
  let lastError = null;
  
  while (attempts < maxRetries) {
    attempts++;
    try {
      // Get the text response
      const jsonText = await generateClaudeCodeText({
        messages: jsonMessages,
        maxTokens,
        temperature
      });
      
      log('debug', `Raw response from Claude: ${jsonText.substring(0, 500)}...`);
      
      // Try to extract JSON from the response
      let jsonObject;
      
      // First try to parse the entire response as JSON
      try {
        jsonObject = JSON.parse(jsonText);
      } catch (e) {
        // If that fails, try to extract JSON from the response
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('Response did not contain valid JSON object');
        }
        jsonObject = JSON.parse(jsonMatch[0]);
      }
      
      // Validate against schema
      const validatedObject = schema.parse(jsonObject);
      
      return validatedObject;
    } catch (error) {
      lastError = error;
      log('warn', `Attempt ${attempts} failed: ${error.message}`);
      
      // Only retry parsing/validation errors, not execution errors
      if (error.message.includes('JSON') || error.message.includes('schema')) {
        continue;
      } else {
        throw error; // Don't retry execution errors
      }
    }
  }
  
  throw new Error(`Failed to generate valid object after ${maxRetries} attempts: ${lastError.message}`);
}