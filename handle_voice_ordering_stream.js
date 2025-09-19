import express from 'express';
import ngrok from 'ngrok';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import OpenAI from 'openai';
import { twiml as twimlVoice } from 'twilio';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse form data
app.use(bodyParser.urlencoded({ extended: false }));

// Your existing code (DynamoDB, OpenAI, MENU, etc.) goes here
// ... [PASTE ALL YOUR EXISTING CODE FROM THE LAMBDA HERE] ...

// Add this function to handle audio conversion locally
async function convertAudioForTwilio(audioBuffer, sampleRate = 8000) {
  // This is a simplified version - you might need a proper audio conversion library
  // For local development, you could use ffmpeg via child_process or a WASM version
  console.log('Audio conversion would happen here for production');
  // Return the audio as-is for local testing (Twilio might not play it correctly)
  return audioBuffer;
}

// Express routes instead of Lambda handler
app.post('/voice', async (req, res) => {
  console.log('Voice endpoint called');
  const callSid = req.body.CallSid;
  
  const twiml = new twimlVoice.VoiceResponse();
  const initialSession = {
    order: { items: [] },
    conversationHistory: [],
    pendingItem: null,
    currentModifiers: null
  };
  
  await putSession(callSid, initialSession);
  
  const gather = twiml.gather({
    input: ['speech'],
    action: '/gather',
    method: 'POST',
    speechTimeout: '1',
    voice: 'Polly.Joanna-Neural',
    language: 'en-IN'
  });
  
  gather.say(PRE_GENERATED_RESPONSES.welcome);
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/gather', async (req, res) => {
  console.log('Gather endpoint called');
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  
  const twiml = new twimlVoice.VoiceResponse();
  const prior = (await getSession(callSid)) || { 
    order: { items: [] }, 
    conversationHistory: [],
    pendingItem: null,
    currentModifiers: null
  };

  console.log('Prior session:', JSON.stringify(prior));

  let ai = handleCommonQuery(speech, prior);
  console.log('Fast path AI:', ai);
  
  if (!ai) {
    ai = await cachedAiUpdate({ userText: speech, prior: prior });
  }

  console.log('AI result:', ai);

  const updatedHistory = prior.conversationHistory?.slice(-1) || [];
  updatedHistory.push({ role: 'user', content: speech });
  updatedHistory.push({ role: 'assistant', content: ai.prompt });
  
  await putSession(callSid, {
    ...prior,
    order: ai.order,
    lastAiAction: ai.action,
    conversationHistory: updatedHistory
  });

  console.log('AI action:', ai.action);
  const handler = actionHandlers[ai.action];
  
  if (handler) {
    const result = await handler(ai, prior, twiml, callSid);
    res.type('text/xml');
    res.send(result.body);
  } else {
    const gather = twiml.gather({
      input: ['speech'],
      action: '/gather',
      method: 'POST',
      speechTimeout: '1',
      language: 'en-IN',
      voice: 'Polly.Joanna-Neural',
    });
    gather.say("I didn't quite get that. You can ask about our menu, order items, or check your total.");
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

app.post('/modifiers', async (req, res) => {
  console.log('Modifiers endpoint called');
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  
  const twiml = new twimlVoice.VoiceResponse();
  const prior = await getSession(callSid) || { 
    order: { items: [] }, 
    conversationHistory: [],
    pendingItem: null,
    currentModifiers: null
  };

  if (!prior.pendingItem || !prior.currentModifiers) {
    const result = await actionHandlers.unknown({}, prior, twiml, callSid);
    res.type('text/xml');
    res.send(result.body);
    return;
  }

  const currentModifier = prior.currentModifiers[0];
  const selectedOption = currentModifier.options.find((opt) => 
    speech.toLowerCase().includes(opt.toLowerCase())
  );

  if (selectedOption) {
    prior.pendingItem.modifiers[currentModifier.key] = {
      name: currentModifier.name,
      selected: selectedOption,
      price: currentModifier.price
    };

    const remainingModifiers = prior.currentModifiers.slice(1);
    
    if (remainingModifiers.length > 0) {
      await putSession(callSid, {
        ...prior,
        currentModifiers: remainingModifiers
      });

      const nextModifier = remainingModifiers[0];
      const gather = twiml.gather({
        input: ['speech'],
        action: '/modifiers',
        method: 'POST',
        speechTimeout: '1',
        language: 'en-IN',
        voice: 'Polly.Joanna-Neural',
      });
      
      const optionsText = nextModifier.options.slice(0, 3).join(', ');
      gather.say(
        `What ${nextModifier.name} would you like? Options: ${optionsText}${nextModifier.options.length > 3 ? ', or others' : ''}${nextModifier.price > 0 ? ` (additional $${nextModifier.price})` : ''}`
      );
    } else {
      const updatedOrder = { ...prior.order };
      if (!updatedOrder.items) updatedOrder.items = [];
      updatedOrder.items.push(prior.pendingItem);
      
      await putSession(callSid, {
        ...prior,
        order: updatedOrder,
        pendingItem: null,
        currentModifiers: null
      });

      const gather = twiml.gather({
        input: ['speech'],
        action: '/gather',
        method: 'POST',
        speechTimeout: '1',
        language: 'en-IN',
        voice: 'Polly.Joanna-Neural',
      });
      gather.say(`Added to your order. Your total is now $${getOrderTotal(updatedOrder).toFixed(2)}. What else would you like?`);
    }
  } else {
    const gather = twiml.gather({
      input: ['speech'],
      action: '/modifiers',
      method: 'POST',
      speechTimeout: '1',
      language: 'en-IN',
      voice: 'Polly.Joanna-Neural',
    });
    gather.say(`Please choose from: ${currentModifier.options.slice(0, 3).join(', ')}${currentModifier.options.length > 3 ? ', or others' : ''}`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/confirm', async (req, res) => {
  console.log('Confirm endpoint called');
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim().toLowerCase();
  
  const twiml = new twimlVoice.VoiceResponse();
  const session = await getSession(callSid);
  const orderData = session?.order ?? { items: [] };
  const total = getOrderTotal(orderData);
  const items = getOrderSummary(orderData);

  if (speech.includes('yes') || speech.includes('confirm')) {
    twiml.say(`Great! Your order of ${items} totaling ${total.toFixed(2)} dollars is placed. Goodbye!`);
    twiml.hangup();
    await deleteSession(callSid);
    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  if (speech.includes('no') || speech.includes('cancel')) {
    twiml.say('Okay, order canceled. Goodbye!');
    twiml.hangup();
    await deleteSession(callSid);
    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  const gather = twiml.gather({
    input: ['speech'],
    action: '/confirm',
    method: 'POST',
    speechTimeout: '1',
    language: 'en-IN',
    voice: 'Polly.Joanna-Neural',
  });
  gather.say(`Please say confirm to place the order of ${items} for ${total.toFixed(2)} dollars, or cancel to stop.`);
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Start server and ngrok tunnel
async function startServer() {
  // Start Express server
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Start ngrok tunnel
  try {
    const url = await ngrok.connect(PORT);
    console.log(`Ngrok tunnel created: ${url}`);
    console.log(`Update your Twilio webhook to: ${url}/voice`);
  } catch (error) {
    console.error('Error creating ngrok tunnel:', error);
    console.log('You can manually expose your local server using ngrok or another service');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await ngrok.kill();
  process.exit(0);
});

startServer();