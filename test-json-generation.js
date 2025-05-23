#!/usr/bin/env node

import { generateClaudeCodeObject } from './src/ai-providers/claude-code.js';
import { z } from 'zod';

// Simple test schema
const testSchema = z.object({
  name: z.string(),
  age: z.number(),
  city: z.string()
});

async function test() {
  console.log('Testing Claude Code JSON generation...');
  
  try {
    const result = await generateClaudeCodeObject({
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that generates JSON data.'
        },
        {
          role: 'user',
          content: 'Generate a person object with name "John Doe", age 30, and city "New York"'
        }
      ],
      schema: testSchema,
      objectName: 'person'
    });
    
    console.log('Success! Generated object:', result);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();