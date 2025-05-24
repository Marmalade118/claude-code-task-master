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
  log('debug', `Parameters: maxTokens=${maxTokens}, temperature=${temperature}`);
  log('debug', `Messages array length: ${messages?.length || 0}`);
  
  // Check if we have a system message and a user message
  const systemMessage = messages.find(msg => msg.role === 'system')?.content || '';
  const userMessages = messages.filter(msg => msg.role === 'user');
  
  if (userMessages.length === 0) {
    throw new Error('At least one user message is required');
  }
  
  log('debug', `System message length: ${systemMessage.length}`);
  log('debug', `User messages count: ${userMessages.length}`);
  
  // Get the most recent user message
  const userMessage = userMessages[userMessages.length - 1].content;
  
  // Combine system message and user message
  const promptContent = systemMessage ? `${systemMessage}\n\n${userMessage}` : userMessage;
  
  // Prepare Claude Code CLI command
  const claudeCodePath = getClaudeCodePath();
  // Use --print for non-interactive output and specify model
  // For text generation, use text format; for objects, we'll use a separate approach
  const args = ['--print', '--model', 'sonnet'];
  
  // Add higher token limits for object generation if this is for structured output
  if (maxTokens && maxTokens > 4000) {
    log('debug', `Using higher token limit: ${maxTokens}`);
  }
  
  // Execute Claude Code CLI
  log('debug', `Executing: ${claudeCodePath} ${args.join(' ')}`);
  log('debug', `Prompt content preview: ${promptContent.substring(0, 100)}...`);
  
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
      log('debug', `Claude CLI process closed with code ${code}`);
      log('debug', `Stdout length: ${stdout.length}, Stderr length: ${stderr.length}`);
      
      if (code === 0) {
        const result = stdout.trim();
        if (!result) {
          log('error', 'Claude CLI returned empty response');
          log('debug', `Full stderr: ${stderr}`);
          reject(new Error('Claude Code CLI returned empty response'));
        } else {
          log('debug', `Returning text result of length: ${result.length}`);
          // Return in the expected format with mainResult wrapper
          resolve({
            mainResult: result
          });
        }
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
  const response = await generateClaudeCodeText(params);
  const text = response.mainResult;
  
  return {
    mainResult: text,
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
  systemPrompt += `\n\nIMPORTANT: You must output ONLY valid JSON. No markdown, no code blocks, no explanations.\n`;
  systemPrompt += `Output a single JSON object for ${objectName} that matches this exact structure:\n`;
  systemPrompt += JSON.stringify(schema._def.shape(), null, 2) + '\n';
  systemPrompt += `Remember: Output ONLY the JSON object starting with { and ending with }. No other text.`;
  
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
      const response = await generateClaudeCodeText({
        messages: jsonMessages,
        maxTokens,
        temperature
      });
      
      // Extract the text from the response object
      const jsonText = response.mainResult;
      
      log('debug', `Raw response from Claude (attempt ${attempts}): ${jsonText.substring(0, 500)}...`);
      
      // Write full response to temp file for debugging
      const debugFile = path.join(os.tmpdir(), `claude-response-${uuidv4()}.txt`);
      fs.writeFileSync(debugFile, jsonText);
      log('debug', `Full response written to: ${debugFile}`);
      
      // Try to extract JSON from the response
      let jsonObject;
      let cleanedText = jsonText.trim();
      
      // Remove common markdown code block wrappers if present
      cleanedText = cleanedText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      cleanedText = cleanedText.replace(/^```\s*/i, '').replace(/\s*```$/i, '');
      
      // Fix improperly escaped quotes and malformed JSON
      // This handles cases where Claude returns malformed JSON with mixed escaping
      cleanedText = cleanedText.replace(/\\"/g, '"');
      
      // Fix specific pattern we're seeing: \"description",: should be "description":
      cleanedText = cleanedText.replace(/"([^"]*)"\\?,:/g, '"$1":');
      
      // Fix any remaining backslashes before quotes
      cleanedText = cleanedText.replace(/\\(["])/g, '$1');
      
      // First try to parse the cleaned response as JSON
      try {
        jsonObject = JSON.parse(cleanedText);
      } catch (e) {
        // If that fails, try to extract JSON using various patterns
        let jsonMatch = null;
        
        // Try to find JSON object starting with { and ending with }
        const patterns = [
          /\{[\s\S]*\}/,  // Any JSON object
          /\{\s*"tasks"[\s\S]*\}/,  // Specifically looking for tasks object
          /\{\s*"[\w]+"[\s\S]*\}/  // Any object starting with a quoted key
        ];
        
        for (const pattern of patterns) {
          jsonMatch = cleanedText.match(pattern);
          if (jsonMatch) break;
        }
        
        if (!jsonMatch) {
          // Log more details for debugging
          log('error', `Could not find JSON in response. First 200 chars: ${cleanedText.substring(0, 200)}`);
          log('error', `Last 200 chars: ${cleanedText.substring(Math.max(0, cleanedText.length - 200))}`);
          
          // Check if the response looks like it was truncated
          if (cleanedText.length > 8000 && !cleanedText.trim().endsWith('}')) {
            throw new Error('Response appears to be truncated - consider reducing the number of tasks or complexity');
          }
          
          throw new Error('Response did not contain valid JSON object');
        }
        
        try {
          jsonObject = JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          // Try to fix common JSON issues
          let fixedJson = jsonMatch[0];
          
          // Fix improperly escaped quotes first
          fixedJson = fixedJson.replace(/\\"/g, '"');
          
          // Fix specific malformed patterns like \"key",: to "key":
          fixedJson = fixedJson.replace(/"([^"]*)"\\?,:/g, '"$1":');
          fixedJson = fixedJson.replace(/\\(["])/g, '$1');
          
          // Fix trailing commas
          fixedJson = fixedJson.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          
          // Fix line breaks in string values (replace actual newlines with \n)
          fixedJson = fixedJson.replace(/"([^"]*)"/g, (match, content) => {
            return '"' + content.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
          });
          
          try {
            jsonObject = JSON.parse(fixedJson);
          } catch (fixError) {
            // Extract error position info if available
            const errorMatch = fixError.message.match(/position (\d+)/);
            if (errorMatch) {
              const position = parseInt(errorMatch[1]);
              const contextStart = Math.max(0, position - 50);
              const contextEnd = Math.min(fixedJson.length, position + 50);
              const errorContext = fixedJson.substring(contextStart, contextEnd);
              const relativePos = position - contextStart;
              log('error', `JSON parse error at position ${position}:`);
              log('error', `Context: ${errorContext}`);
              log('error', `         ${' '.repeat(relativePos)}^`);
              
              // Check if this looks like a truncation issue
              if (position > fixedJson.length - 100) {
                log('error', 'Error occurs near end of response - likely truncated');
                throw new Error('Response appears to be truncated. Try reducing --num-tasks or simplifying the PRD.');
              }
            }
            log('error', `Failed to parse even after fixes. JSON fragment: ${fixedJson.substring(0, 200)}`);
            log('error', `Full response length: ${jsonText?.length || 0} characters`);
            throw new Error(`JSON parsing failed: ${parseError.message}`);
          }
        }
      }
      
      // Validate against schema
      const validatedObject = schema.parse(jsonObject);
      
      log('debug', `Successfully validated object on attempt ${attempts}`);
      
      // Return in the expected format with mainResult wrapper
      return {
        mainResult: validatedObject
      };
    } catch (error) {
      lastError = error;
      log('warn', `Attempt ${attempts} failed: ${error.message}`);
      
      // Add the raw response to the error for better debugging
      if (attempts === maxRetries) {
        log('error', `All attempts failed. Last raw response: ${jsonText?.substring(0, 1000) || 'No response'}`);
      }
      
      // Only retry parsing/validation errors, not execution errors
      if (error.message.includes('JSON') || error.message.includes('parse') || 
          error.message.includes('schema') || error.message.includes('Expected')) {
        continue;
      } else {
        throw error; // Don't retry execution errors
      }
    }
  }
  
  throw new Error(`Failed to generate valid object after ${maxRetries} attempts: ${lastError.message}`);
}