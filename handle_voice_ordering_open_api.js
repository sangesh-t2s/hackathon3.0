import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import axios from 'axios'
import OpenAI from 'openai'
import { twiml as twimlVoice } from 'twilio'

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * MENU: Categories → Items → Modifiers
 * ──────────────────────────────────────────────────────────────────────────────
 */
type ModifierChoice = { name: string; priceDelta?: number }
type ModifierGroup = { name: string; required?: boolean; choices: ModifierChoice[] }
type ItemDef = { name: string; price: number; modifiers?: ModifierGroup[] }
type CategoryDef = { name: string; items: ItemDef[] }

const MENU_V2: CategoryDef[] = [
  {
    name: 'Burgers',
    items: [
      {
        name: 'Cheese burger',
        price: 5,
        modifiers: [
          {
            name: 'Patty Size',
            required: false,
            choices: [
              { name: 'Single' },
              { name: 'Double', priceDelta: 2 },
            ],
          },
          {
            name: 'Extras',
            required: false,
            choices: [
              { name: 'Pickle', priceDelta: 1 },
              { name: 'Bacon', priceDelta: 2 },
            ],
          },
        ],
      },
      {
          name: 'Chicken burger',
        price: 5,
        modifiers: [
          {
            name: 'Patty Size',
            required: false,
            choices: [
              { name: 'Single' },
              { name: 'Double', priceDelta: 2 },
            ],
          },
          {
            name: 'Extras',
            required: false,
            choices: [
              { name: 'Pickle', priceDelta: 1 },
              { name: 'Bacon', priceDelta: 2 },
            ],
          },
        ],
      }
    ],
  },
  {
    name: 'Briyani',
    items: [
      {
        name: 'Veg',
        price: 2,
        modifiers: [{
          name: 'Briyani',
          choices: [{ name: 'Paneer' , priceDelta: 2}, { name: 'Mushroom', priceDelta: 2 }],
        }]

      },
      { name: 'Non Veg ', price: 4 ,
        modifiers: [{
          name: 'Briyani',
          choices: [{ name: 'Chicken' , priceDelta: 4}, { name: 'Mutton', priceDelta: 5 }],
        }]
      },
    ],
  },
  {
    name: 'Drinks',
    items: [
      {
        name: 'Coke',
        price: 1,
      },
       {
        name: 'Fanta',
        price: 1,
      },
    ],
  },
  {
    name: 'Pizzas',
    items: [
      {
        name: 'Paneer Pizza',
        price: 9,
        modifiers: [
          {
            name: 'Crust',
            choices: [{ name: 'Thin' }, { name: 'Regular' }],
          },
          {
            name: 'Toppings',
            choices: [
              { name: 'Pepperoni', priceDelta: 1.5 },
              { name: 'Mushrooms', priceDelta: 1 },
              { name: 'Olives', priceDelta: 1 },
            ],
          },
        ],
      },
       {
        name: 'Chicken Pizza',
        price: 9,
        modifiers: [
          {
            name: 'Crust',
            choices: [{ name: 'Thin' }, { name: 'Regular' }],
          },
          {
            name: 'Toppings',
            choices: [
              { name: 'Pepperoni', priceDelta: 1.5 },
              { name: 'Mushrooms', priceDelta: 1 },
              { name: 'Olives', priceDelta: 1 },
            ],
          },
        ],
      },
    ],
  },
]

/**
 * Popular & suggestions (for recommendations/upsells)
 */
const POPULAR_ITEMS = [
  { category: 'Burgers', item: 'Cheeseburger' },
  { category: 'Pizzas', item: 'Pizza' },
  { category: 'Sides', item: 'Fries' },
  { category: 'Drinks', item: 'Coke' },
]

const SUGGESTED_PAIRINGS: Record<string, { category: string; item: string }[]> = {
  Cheeseburger: [{ category: 'Sides', item: 'Fries' }, { category: 'Drinks', item: 'Coke' }],
  Pizza: [{ category: 'Drinks', item: 'Coke' }, { category: 'Sides', item: 'Salad' }],
  Fries: [{ category: 'Drinks', item: 'Coke' }],
}

/**
 * Discounts / promos
 * SAVE10: 10% off subtotal ≥ $20
 * FREEDRINK: 1 free Coke when the order includes a Pizza
 */
type DiscountTotals = { amount: number; notes: string[] }
type DiscountDef = {
  code: string
  description: string
  apply: (order: Order) => DiscountTotals | null // null if not eligible
  stackable?: boolean
}

const DISCOUNTS: Record<string, DiscountDef> = {
  SAVE10: {
    code: 'SAVE10',
    description: '10% off orders of $20 or more',
    apply: (order) => {
      const subtotal = computeSubtotal(order)
      if (subtotal >= 20) {
        const amount = +(subtotal * 0.1).toFixed(2)
        return { amount, notes: ['SAVE10 applied (10% off)'] }
      }
      return null
    },
    stackable: true,
  },
  FREEDRINK: {
    code: 'FREEDRINK',
    description: 'Free Coke when you order a Pizza',
    apply: (order) => {
      const hasPizza = order.items.some((i) => i.name.toLowerCase() === 'pizza')
      if (!hasPizza) return null
      const cokePrice = findItemPrice('Drinks', 'Coke') ?? 1
      return { amount: cokePrice, notes: ['FREEDRINK applied (free Coke)'] }
    },
    stackable: true,
  },
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * AWS + OpenAI
 * ──────────────────────────────────────────────────────────────────────────────
 */
const ddbClient = new DynamoDBClient()
const ddb = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true, convertEmptyValues: true },
  unmarshallOptions: { wrapNumbers: false },
})

const SESSIONS_TABLE = process.env.SESSIONS_TABLE_NAME
const openai = new OpenAI({  })

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Session / Order types
 * ──────────────────────────────────────────────────────────────────────────────
 */
type ChosenModifiers = Record<string, ModifierChoice[]> // group -> choices

type OrderItem = {
  category: string
  name: string
  basePrice: number
  quantity: number
  modifiers?: ChosenModifiers
  price?: number // per unit including modifiers
}

type Order = { items: OrderItem[] }

type Phase = 'choose_category' | 'choose_item' | 'choose_modifiers' | 'collecting' | 'confirm'

type SessionState = {
  order: Order
  phase: Phase
  selectedCategory?: string
  selectedItem?: string
  pendingModifiers?: {
    item: string
    groupsLeft: string[]
    chosen: ChosenModifiers
  }
  appliedDiscounts?: string[] // list of codes
  lastAiAction?: string
  conversationHistory: any[]
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * DB helpers
 * ──────────────────────────────────────────────────────────────────────────────
 */
async function getSession(callSid: string): Promise<SessionState | null> {
  const res = await ddb.send(new GetCommand({ TableName: SESSIONS_TABLE, Key: { CallSid: callSid } }))
  return (res.Item?.sessionData as SessionState) ?? null
}

async function putSession(callSid: string, sessionData: SessionState) {
  console.log('sessionData to be saved:', JSON.stringify(sessionData, null, 2))
  return ddb.send(
    new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: { CallSid: callSid, sessionData, lastUpdated: new Date().toISOString() },
    })
  )
}

async function deleteSession(callSid: string) {
  return ddb
    .send(new UpdateCommand({ TableName: SESSIONS_TABLE, Key: { CallSid: callSid }, UpdateExpression: 'REMOVE sessionData' }))
    .catch(() => {})
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Menu lookups & pricing
 * ──────────────────────────────────────────────────────────────────────────────
 */
const norm = (s: string) => s.toLowerCase().trim()

function listCategories(): string[] {
  return MENU_V2.map((c) => c.name)
}
function getCategory(name: string): CategoryDef | undefined {
  const n = norm(name)
  return MENU_V2.find((c) => norm(c.name) === n || n.includes(norm(c.name)))
}
function listItemsOf(category: string): string[] {
  const cat = getCategory(category)
  return cat ? cat.items.map((i) => i.name) : []
}
function getItem(category: string, itemName: string): ItemDef | undefined {
  const cat = getCategory(category)
  if (!cat) return
  const n = norm(itemName)
  return cat.items.find((i) => norm(i.name) === n || n.includes(norm(i.name)))
}
function listModifierGroups(item: ItemDef): string[] {
  return item.modifiers?.map((m) => m.name) ?? []
}
function listModifierChoices(item: ItemDef, groupName: string): ModifierChoice[] {
  const g = item.modifiers?.find((m) => norm(m.name) === norm(groupName))
  return g?.choices ?? []
}
function priceWithModifiers(item: ItemDef, chosen?: ChosenModifiers): number {
  let price = item.price
  if (chosen) {
    for (const group of Object.keys(chosen)) {
      for (const choice of chosen[group]) price += choice.priceDelta ?? 0
    }
  }
  return price
}
function findItemPrice(category: string, itemName: string): number | undefined {
  return getItem(category, itemName)?.price
}

/** Subtotal/discounts/totals **/
function computeSubtotal(order: Order) {
  if (!order?.items?.length) return 0
  return order.items.reduce((sum, i) => sum + (i.price ?? i.basePrice) * (i.quantity || 1), 0)
}

function computeDiscounts(order: Order, codes: string[] = []): DiscountTotals {
  const applied: DiscountTotals = { amount: 0, notes: [] }
  for (const code of codes) {
    const def = DISCOUNTS[code.toUpperCase()]
    if (!def) continue
    const res = def.apply(order)
    if (res) {
      applied.amount += res.amount
      applied.notes.push(...res.notes)
    }
  }
  // clamp
  const subtotal = computeSubtotal(order)
  if (applied.amount > subtotal) applied.amount = subtotal
  return applied
}

function computeTotals(order: Order, codes: string[] = []) {
  const subtotal = computeSubtotal(order)
  const d = computeDiscounts(order, codes)
  const total = Math.max(0, +(subtotal - d.amount).toFixed(2))
  return { subtotal: +subtotal.toFixed(2), discount: +d.amount.toFixed(2), total, notes: d.notes }
}

function getOrderSummary(order: Order) {
  if (!order?.items?.length) return 'no items yet'
  return order.items
    .map((i) => {
      const mods =
        i.modifiers && Object.keys(i.modifiers).length
          ? ` (${Object.entries(i.modifiers)
              .map(([g, choices]) => `${g}: ${choices.map((c) => c.name).join(', ')}`)
              .join('; ')})`
          : ''
      return `${i.quantity > 1 ? i.quantity + ' ' : ''}${i.name}${mods}`
    })
    .join(', ')
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Friendly prompts
 * ──────────────────────────────────────────────────────────────────────────────
 */
function sayList(prefix: string, items: string[]) {
  if (!items.length) return prefix
  const joined = items.join(', ').replace(/, ([^,]*)$/, ', and $1')
  return `${prefix} ${joined}.`
}
function promptForCategory() {
  return 'Please choose a category to get started—Burgers, Sides, Drinks, or Pizzas.'
}
function promptForItem(category: string) {
  const items = listItemsOf(category)
  if (!items.length) return `Hmm, I couldn’t find items under ${category}. Let’s try a different category.`
  return `Great choice—${category}! ${sayList('Here are the options:', items)} Which one sounds good to you?`
}
function promptForModifiers(item: ItemDef, groupsLeft: string[]) {
  const g = groupsLeft[0]
  const choices = listModifierChoices(item, g)
  if (!choices.length) return `No options for ${g}.`
  const choiceText = choices.map((c) => (c.priceDelta ? `${c.name} (adds ${c.priceDelta} dollars)` : c.name)).join(', ')
  return `For your ${item.name}, what would you like for ${g}?”. Available choices are ${choiceText}.`
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Deterministic speech pickers (no AI)
 * ──────────────────────────────────────────────────────────────────────────────
 */
function pickCategoryFrom(utterance: string): string | undefined {
  const u = norm(utterance)
  for (const c of listCategories()) {
    const n = norm(c)
    if (u === n || u.includes(n) || n.includes(u)) return c
  }
  return undefined
}
function pickItemFrom(category: string, utterance: string): string | undefined {
  const u = norm(utterance)
  for (const i of listItemsOf(category)) {
    const n = norm(i)
    if (u === n || u.includes(n) || n.includes(u)) return i
  }
  return undefined
}
function pickModifierChoicesFrom(item: ItemDef, groupName: string, utterance: string): string[] {
  const u = norm(utterance)
  const choices = listModifierChoices(item, groupName)
  const hits: string[] = []
  for (const c of choices) {
    const n = norm(c.name)
    if (u.includes(n)) hits.push(c.name)
  }
  if (!hits.length) {
    for (const c of choices) {
      const n = norm(c.name).replace(/s$/, '')
      if (u.includes(n)) hits.push(c.name)
    }
  }
  return Array.from(new Set(hits))
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * AI (kept for free-form)
 * ──────────────────────────────────────────────────────────────────────────────
 */
const responseCache = new Map<string, any>()
const AI_TIMEOUT = 5000

async function aiUpdateOrderStateWithTimeout({ userText, prior }: { userText: string; prior: SessionState }) {
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT))
  try {
    return await Promise.race([aiUpdateOrderState({ userText, prior }), timeoutPromise])
  } catch {
    return { action: 'unknown', order: prior.order, prompt: "Sorry—my mistake there. Could you say that one more time?", confidence: 0.1 }
  }
}

async function cachedAiUpdate({ userText, prior }: { userText: string; prior: SessionState }) {
  const cacheKey = userText.toLowerCase().trim()
  const common = ['menu', 'categories', 'total', 'what do you have', 'how much', 'thank you', 'thanks', 'discount', 'offer', 'promo', 'coupon', 'bestseller', 'most selling', 'popular']
  if (common.some((q) => cacheKey.includes(q))) {
    const cached = responseCache.get(cacheKey)
    if (cached) return cached
  }
  const result = await aiUpdateOrderStateWithTimeout({ userText, prior })
  if (common.some((q) => cacheKey.includes(q))) {
    responseCache.set(cacheKey, result)
    setTimeout(() => responseCache.delete(cacheKey), 60000)
  }
  return result
}

export async function aiUpdateOrderState({ userText, prior }: { userText: string; prior: SessionState }) {
  const OPTIMIZED_SYSTEM_PROMPT = `
You are a warm, patient food-ordering IVR assistant.

OUTPUT FORMAT (IMPORTANT):
Return ONLY a valid JSON object. No markdown, no code fences, no commentary.
Return JSON with: action, order, prompt, confidence, itemQueried?, newQuantity?, modifiers?(group->choices), category?, item?, discountCode?.

ACTIONS:
- collecting, confirm, info, cancel, update_quantity, reset, help, recommend, acknowledge, smalltalk, apologize, unrecognized_item, clarify, discounts, apply_discount, most_selling, suggest, greeting, prompt, repeat_last, unknown

RULES:
- Default quantity = 1
- "yes", "that’s correct", "confirm", "please confirm", "looks good", "go ahead" → **action = confirm**
- If user only chose a category or item, use "clarify" with a helpful next-step prompt.
- For "discounts" inquiries: explain available codes and ask if you'd like to apply one.
- For "apply_discount": extract code (e.g., SAVE10), include "discountCode".
- For "most_selling" or "recommend": suggest 2–3 items.
- Keep tone friendly and concise.

MENU:
${MENU_V2.map((c) => `- ${c.name}: ${c.items.map((i) => `${i.name} ($${i.price})`).join('; ')}`).join('\n')}
DISCOUNTS:
- SAVE10: 10% off orders of $20 or more
- FREEDRINK: Free Coke when you order a Pizza
`
  const recent = prior.conversationHistory?.slice(-1) || []
  const messages = [
    { role: 'system', content: OPTIMIZED_SYSTEM_PROMPT },
    ...recent,
    { role: 'user', content: `User said: "${userText}"` },
    { role: 'assistant', content: `Current order: ${JSON.stringify(prior.order)}` },
  ]

  let ai: any
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages,
    })
    console.log('AI response:', response.choices[0].message.content)
    ai = JSON.parse(response.choices[0].message.content ?? '{}')
  } catch (e) {
    console.log('AI error:', e)
    ai = { action: 'unknown', order: prior.order, prompt: `Hmm, I didn’t catch that. Could you say it again?`, confidence: 0.4 }
  }
  return ai
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * TwiML helper
 * ──────────────────────────────────────────────────────────────────────────────
 */
type AiActionHandler = (ai: any, prior: SessionState, twiml: any, callSid: string) => Promise<any>

function buildXmlResponse(twimlXml: string) {
  return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: twimlXml }
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Action handlers (friendly, with discounts & recommendations)
 * ──────────────────────────────────────────────────────────────────────────────
 */
const VOICE = 'Polly.Danielle-Generative'

const actionHandlers: Record<string, AiActionHandler> = {
  cancel: async (ai, _prior, twiml, callSid) => {
    twiml.say(ai.prompt || 'Okay, I’ve cancelled that for you. Thanks for calling and have a lovely day!')
    twiml.hangup()
    await deleteSession(callSid)
    return buildXmlResponse(twiml.toString())
  },

  confirm: async (_ai, prior, twiml) => {
    const { subtotal, discount, total, notes } = computeTotals(prior.order, prior.appliedDiscounts)
    const items = getOrderSummary(prior.order)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/confirm', method: 'POST', voice: VOICE, speechTimeout: '1', language: 'en-IN' })
    const discountLine = discount > 0 ? ` after ${discount.toFixed(2)} dollars in discounts (${notes.join('; ')}).` : '.'
    gather.say(`Here’s your order: ${items}. Subtotal is ${subtotal.toFixed(2)} dollars${discountLine} Your total is ${total.toFixed(2)} dollars. Would you like me to place it now? Say “confirm” or “cancel”.`)
    return buildXmlResponse(twiml.toString())
  },

  info: async (ai, prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    switch (ai.itemQueried) {
      case 'categories':
      case 'menu':
        gather.say(`Happy to help. ${promptForCategory()}`)
        break
      case 'total': {
        const { subtotal, discount, total, notes } = computeTotals(prior.order, prior.appliedDiscounts)
        const discStr = discount > 0 ? `, with ${discount.toFixed(2)} dollars off (${notes.join('; ')}),` : ''
        gather.say(`So far your subtotal is ${subtotal.toFixed(2)} dollars${discStr} and your total is ${total.toFixed(2)} dollars. Would you like to add anything else?`)
        break
      }
      case 'order_summary':
        gather.say(`Right now you have ${getOrderSummary(prior.order)}. Want to add something or make a change?`)
        break
      case 'payment_methods':
        gather.say(`We accept credit cards, debit cards, and cash on delivery. What would you like to do next?`)
        break
      case 'delivery_time':
        gather.say(`Estimated delivery time is about 30 minutes. Shall we continue with your order?`)
        break
      case 'store_info':
        gather.say(`We’re at 123 Main Street and open 10 AM to 10 PM every day. What would you like to order?`)
        break
      default:
        gather.say(ai.prompt || `I’m here—could you share that once more?`)
    }
    return buildXmlResponse(twiml.toString())
  },

  update_quantity: async (ai, prior, twiml, callSid) => {
    const updatedOrder = { ...prior.order }
    const item = updatedOrder.items.find((i) => norm(i.name) === norm(ai.itemQueried))
    if (item) item.quantity = ai.newQuantity
    console.log('Updating order quantity:', prior.order, '->', updatedOrder)
    await putSession(callSid, { ...prior, order: updatedOrder })
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(`All set—${ai.itemQueried} is now ${ai.newQuantity}. Would you like anything else?`)
    return buildXmlResponse(twiml.toString())
  },

  reset: async (_ai, _prior, twiml, callSid) => {
    const fresh: SessionState = { order: { items: [] }, phase: 'choose_category', conversationHistory: [], appliedDiscounts: [] }
    console.log('Resetting session', callSid, fresh)
    await putSession(callSid, fresh)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`No problem—let’s start fresh. ${promptForCategory()}`)
    return buildXmlResponse(twiml.toString())
  },

  repeat_last: async (_ai, prior, twiml) => {
    const lastAssistant = prior.conversationHistory?.filter((m) => m.role === 'assistant').slice(-1)[0]
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(lastAssistant?.content || 'I didn’t say anything just yet. What would you like to order?')
    return buildXmlResponse(twiml.toString())
  },

  help: async (_ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`I can walk you through it—no rush. First, pick a category like Burgers, Sides, Drinks, or Pizzas. Then choose an item and any extras you want. You can always ask for your total or say “confirm” when you’re ready.`)
    return buildXmlResponse(twiml.toString())
  },

  greeting: async (_ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`Hi there, welcome to Demo Bites! I’m here to help you place an order. ${promptForCategory()}`)
    return buildXmlResponse(twiml.toString())
  },

  unknown: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `Sorry—I didn’t quite get that. Could you say it one more time?`)
    return buildXmlResponse(twiml.toString())
  },

  acknowledge: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `You’re very welcome! Would you like to add anything else, or should I read your total?`)
    return buildXmlResponse(twiml.toString())
  },

  prompt: async (_ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`Still with me? Take your time. ${promptForCategory()}`)
    return buildXmlResponse(twiml.toString())
  },

  apologize: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `I’m sorry about that experience. I’ll do better. Would you like to continue with your order?`)
    return buildXmlResponse(twiml.toString())
  },

  smalltalk: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `I’m doing great—thanks for asking! Ready to choose a category?`)
    return buildXmlResponse(twiml.toString())
  },

  fun: async (_ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(`Here’s one—what do pizzas wear to look cool? Toppings! Alright, which category would you like to start with?`)
    return buildXmlResponse(twiml.toString())
  },

  escalate: async (_ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN' })
    gather.say(`I understand—you’d like to talk to a team member. Please hold while I connect you.`)
    return buildXmlResponse(twiml.toString())
  },

  system_info: async (_ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(`I’m your ordering assistant for Demo Bites—here to make things quick and easy.`)
    return buildXmlResponse(twiml.toString())
  },

  unrecognized_item: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`I don’t think we have ${ai.itemQueried || 'that item'} today. No worries—let’s pick something we do have. ${promptForCategory()}`)
    return buildXmlResponse(twiml.toString())
  },

  inactive: async (_ai, _prior, twiml, callSid) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', timeout: 5, speechTimeout: '1', language: 'en-IN' })
    gather.say(`Just checking in. If you need a moment, that’s okay. I’ll stay on for a bit.`)
    setTimeout(async () => {
      twiml.say(`I’ll let you go for now, but feel free to call anytime. Take care!`)
      twiml.hangup()
      await deleteSession(callSid)
    }, 15000)
    return buildXmlResponse(twiml.toString())
  },

  clarify: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `Got it. Tell me a category like Burgers or Pizzas, then the item, and any extras you’d like.`)
    return buildXmlResponse(twiml.toString())
  },

  /** Guided flow **/
  choose_category: async (ai, prior, twiml, callSid) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    let category = ai.category || prior.selectedCategory
    if (!category) {
      gather.say(`No rush—let’s begin. ${promptForCategory()}`)
      return buildXmlResponse(twiml.toString())
    }
    const cat = getCategory(category)
    if (!cat) {
      gather.say(`I couldn’t find “${category}”. That happens! ${promptForCategory()}`)
      return buildXmlResponse(twiml.toString())
    }
    const next: SessionState = { ...prior, phase: 'choose_item', selectedCategory: cat.name }
    console.log('Chosen category:', category, '->', cat.name)
    await putSession(callSid, next)
    gather.say(promptForItem(cat.name))
    return buildXmlResponse(twiml.toString())
  },

  choose_item: async (ai, prior, twiml, callSid) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    const category = prior.selectedCategory || ai.category
    if (!category || !getCategory(category)) {
      const next: SessionState = { ...prior, phase: 'choose_category' }
      console.log('No category yet, going back:')
      await putSession(callSid, next)
      gather.say(`Let’s pick a category first. ${promptForCategory()}`)
      return buildXmlResponse(twiml.toString())
    }
    let itemName = ai.item || prior.selectedItem
    if (!itemName) {
      gather.say(promptForItem(category))
      return buildXmlResponse(twiml.toString())
    }
    const item = getItem(category, itemName)
    if (!item) {
      gather.say(`I didn’t find “${itemName}” in ${category}. ${promptForItem(category)}`)
      return buildXmlResponse(twiml.toString())
    }
    const groups = listModifierGroups(item)
    if (!groups.length) {
      const price = priceWithModifiers(item)
      const newItem: OrderItem = { category, name: item.name, basePrice: item.price, quantity: 1, price }
      const updatedOrder = { ...prior.order, items: [...(prior.order.items || []), newItem] }
      const next: SessionState = { ...prior, order: updatedOrder, phase: 'collecting', selectedItem: item.name }
      console.log('Item added to order:')
      await putSession(callSid, next)
      const { total } = computeTotals(updatedOrder, prior.appliedDiscounts)
      gather.say(`Nice choice—${item.name} added. Your total is ${total.toFixed(2)} dollars. Would you like to add something else or say “confirm”?`)
      return buildXmlResponse(twiml.toString())
    }
    const next: SessionState = { ...prior, phase: 'choose_modifiers', selectedItem: item.name, pendingModifiers: { item: item.name, groupsLeft: groups, chosen: {} } }
    console.log('Need modifiers, moving on:')
    await putSession(callSid, next)
    gather.say(promptForModifiers(item, groups))
    return buildXmlResponse(twiml.toString())
  },

  choose_modifiers: async (ai, prior, twiml, callSid) => {
    console.log('choose modifiers called ', prior)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    const category = prior.selectedCategory
    const itemName = prior.selectedItem
    console.log('category item name ', category, itemName)
    if (!category || !itemName) {
      const next: SessionState = { ...prior, phase: 'choose_category' }
      console.log('No category/item, going back:')
      await putSession(callSid, next)
      gather.say(`Let’s start from the top. ${promptForCategory()}`)
      return buildXmlResponse(twiml.toString())
    }
    const item = getItem(category, itemName)!
    const pend = prior.pendingModifiers!
    const currentGroup = pend.groupsLeft[0]

    console.log('item Pend ',)

    const choiceNamesFromAi: string[] = ai?.modifiers?.[currentGroup] || pickModifierChoicesFrom(item, currentGroup, ai.userText || '')
    if (!choiceNamesFromAi?.length) {
      gather.say(`No worries—let’s try that again. ${promptForModifiers(item, pend.groupsLeft)}`)
      return buildXmlResponse(twiml.toString())
    }

    const validChoices = listModifierChoices(item, currentGroup)
    const selected: ModifierChoice[] = choiceNamesFromAi
      .map((n) => validChoices.find((c) => norm(c.name) === norm(n)))
      .filter(Boolean) as ModifierChoice[]

    if (!selected.length) {
      gather.say(`Those options aren’t available. ${promptForModifiers(item, pend.groupsLeft)}`)
      return buildXmlResponse(twiml.toString())
    }

    const chosen = { ...pend.chosen, [currentGroup]: selected }
    const remaining = pend.groupsLeft.slice(1)

    if (remaining.length) {
      const next: SessionState = { ...prior, pendingModifiers: { item: item.name, groupsLeft: remaining, chosen } }
      console.log('Modifiers so far:', chosen, 'still need:', remaining)
      await putSession(callSid, next)
      gather.say(promptForModifiers(item, remaining))
      return buildXmlResponse(twiml.toString())
    }

    // done → add line item
    const unitPrice = priceWithModifiers(item, chosen)
    const newItem: OrderItem = { category, name: item.name, basePrice: item.price, quantity: 1, modifiers: chosen, price: unitPrice }
    const updatedOrder = { ...prior.order, items: [...(prior.order.items || []), newItem] }
    const next: SessionState = { ...prior, order: updatedOrder, phase: 'collecting', pendingModifiers: undefined }
    console.log('Final modifiers:', chosen, 'item added to order:')
    await putSession(callSid, next)

    const { total } = computeTotals(updatedOrder, prior.appliedDiscounts)
    const modsSpoken = Object.entries(chosen).map(([g, arr]) => `${g}: ${arr.map((c) => c.name).join(', ')}`).join('; ')
    gather.say(`Perfect—${item.name} with ${modsSpoken} is added. Your total is ${total.toFixed(2)} dollars. Would you like to add more or say “confirm”?`)
    return buildXmlResponse(twiml.toString())
  },

  collecting: async (ai, prior, twiml, callSid) => {
    // AI free-form adds still supported
    const updatedOrder = { ...(prior.order || { items: [] }) }
    if (!updatedOrder.items) updatedOrder.items = []

    let message = ''

    ai.order?.items?.forEach((newItem: any) => {
      const existing = updatedOrder.items.find((i) => norm(i.name) === norm(newItem.name))
      const quantity = Math.max(newItem.quantity || 1, 1)
      const basePrice = newItem.price ?? newItem.basePrice ?? 0
      const perUnit = newItem.price ?? basePrice

      if (existing) {
        existing.quantity += quantity
        message += `Updated ${existing.name} to ${existing.quantity}. `
      } else {
        updatedOrder.items.push({
          category: newItem.category || 'Uncategorized',
          name: newItem.name,
          basePrice,
          price: perUnit,
          quantity,
          modifiers: newItem.modifiers,
        })
        message += `Added ${quantity} ${newItem.name}. `
      }
    })
    console.log('AI-updated order:', prior.order, '->', updatedOrder)

    await putSession(callSid, { ...prior, order: updatedOrder })
    const items = getOrderSummary(updatedOrder)
    const { total } = computeTotals(updatedOrder, prior.appliedDiscounts)

    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `${message}You now have ${items}. Your total is ${total.toFixed(2)} dollars. Would you like to add anything else, make a change, or say “confirm”?`)
    return buildXmlResponse(twiml.toString())
  },

  /** NEW: discount info **/
  discounts: async (_ai, prior, twiml) => {
    const { subtotal } = computeTotals(prior.order, prior.appliedDiscounts)
    const needForSave10 = Math.max(0, 20 - subtotal)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    const lines = [
      `We have a couple of offers right now:`,
      `• SAVE10 — 10% off orders of $20 or more.`,
      `• FREEDRINK — free Coke when you order a Pizza.`,
    ]
    const nudge = subtotal < 20 ? `You’re about $${needForSave10.toFixed(2)} away from SAVE10. Would you like to apply a code now?` : `You’re eligible for SAVE10. Would you like me to apply it?`
    gather.say(`${lines.join(' ')} ${nudge} You can say, “Apply SAVE10” or “Apply FreeDrink”.`)
    return buildXmlResponse(twiml.toString())
  },

  /** NEW: apply discount code **/
  apply_discount: async (ai, prior, twiml, callSid) => {
    const codeRaw: string = (ai.discountCode || '').toString()
    const code = codeRaw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })

    if (!code || !DISCOUNTS[code]) {
      gather.say(`I couldn’t find that promo code. Available ones are SAVE10 and FREEDRINK. Which one would you like to apply?`)
      return buildXmlResponse(twiml.toString())
    }

    const already = (prior.appliedDiscounts || []).includes(code)
    const test = DISCOUNTS[code].apply(prior.order)
    if (already) {
      const { total } = computeTotals(prior.order, prior.appliedDiscounts)
      gather.say(`${code} is already applied. Your total is ${total.toFixed(2)} dollars. Would you like anything else?`)
      return buildXmlResponse(twiml.toString())
    }
    if (!test) {
      if (code === 'SAVE10') {
        const subtotal = computeSubtotal(prior.order)
        const gap = Math.max(0, 20 - subtotal)
        gather.say(`SAVE10 needs a subtotal of at least 20 dollars. You’re about $${gap.toFixed(2)} away. Want a suggestion to reach it?`)
        return buildXmlResponse(twiml.toString())
      }
      if (code === 'FREEDRINK') {
        gather.say(`FREEDRINK works when you have a Pizza in your order. Would you like to add a Pizza?`)
        return buildXmlResponse(twiml.toString())
      }
      gather.say(`That code isn’t eligible just yet. Would you like a recommendation to qualify?`)
      return buildXmlResponse(twiml.toString())
    }

    const next: SessionState = { ...prior, appliedDiscounts: [...(prior.appliedDiscounts || []), code] }
    console.log('Applying discount code:', code, '->', next.appliedDiscounts)
    await putSession(callSid, next)
    const { total, discount, notes } = computeTotals(next.order, next.appliedDiscounts)
    gather.say(`${code} applied—${notes.join('; ')}. Your new total is ${total.toFixed(2)} dollars with ${discount.toFixed(2)} dollars in savings. Anything else?`)
    return buildXmlResponse(twiml.toString())
  },

  /** NEW: most selling / popular **/
  most_selling: async (_ai, _prior, twiml) => {
    const names = POPULAR_ITEMS.map((p) => p.item)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`Our most popular picks are ${names.join(', ')}. Would you like to try one of these? You can say something like “Add Cheeseburger” or “Show Pizzas”.`)
    return buildXmlResponse(twiml.toString())
  },

  /** NEW: smart suggestions (pairings/upsell) **/
  suggest: async (_ai, prior, twiml) => {
    const current = prior.order.items.map((i) => i.name)
    const suggestions: string[] = []
    for (const itemName of current) {
      for (const s of SUGGESTED_PAIRINGS[itemName] || []) {
        suggestions.push(s.item)
      }
    }
    const unique = Array.from(new Set(suggestions)).slice(0, 3)
    const fallback = unique.length ? unique : POPULAR_ITEMS.map((p) => p.item).slice(0, 3)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', language: 'en-IN', voice: VOICE })
    gather.say(`May I suggest ${fallback.join(', ')}? You can say, for example, “Add Fries” or “Add a Coke”.`)
    return buildXmlResponse(twiml.toString())
  },

  /** Existing recommend (kept) **/
  recommend: async (ai, _prior, twiml) => {
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    gather.say(ai.prompt || `Popular picks right now are: ChickenBurger with Pickle, Pizza with Mushrooms. Fancy one of these, or would you like to browse by category?`)
    return buildXmlResponse(twiml.toString())
  },
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Common fast-path queries (now includes discounts & popular)
 * ──────────────────────────────────────────────────────────────────────────────
 */
function handleCommonQuery(userText: string, prior: SessionState) {
  const lower = userText.toLowerCase()

  if (['menu', 'categories', 'what do you have', 'options', 'available'].some((k) => lower.includes(k))) {
    return { action: 'choose_category', order: prior.order, prompt: `Sure—happy to help. ${promptForCategory()}`, confidence: 1.0 }
  }

  if (lower.includes('discount') || lower.includes('offer') || lower.includes('promo') || lower.includes('coupon') || lower.includes('code')) {
    return { action: 'discounts', order: prior.order, prompt: '', confidence: 1.0 }
  }

  if (/(apply|use)\s+(save10|free\s*drink|freedrink)/i.test(lower)) {
    const m = lower.match(/(save10|free\s*drink|freedrink)/i)
    const code = (m?.[1] || '').toUpperCase().replace(/\s+/g, '')
    return { action: 'apply_discount', discountCode: code, order: prior.order, prompt: '', confidence: 1.0 }
  }

  if (lower.includes('most selling') || lower.includes('bestseller') || lower.includes('best seller') || lower.includes('popular') || lower.includes('top seller')) {
    return { action: 'most_selling', order: prior.order, prompt: '', confidence: 1.0 }
  }

  if (lower.includes('suggest') || lower.includes('recommend with') || lower.includes('what goes with') || lower.includes('pair')) {
    return { action: 'suggest', order: prior.order, prompt: '', confidence: 1.0 }
  }

  if (lower.includes('total') || (lower.includes('how much') && !lower.includes('is') && !lower.includes('cost'))) {
    const { total } = computeTotals(prior.order, prior.appliedDiscounts)
    return {
      action: 'info',
      itemQueried: 'total',
      order: prior.order,
      prompt: `Your current total is ${total.toFixed(2)} dollars. Would you like to add more or go ahead and confirm?`,
      confidence: 1.0,
    }
  }

  if (lower.includes('thank') || lower.includes('thanks')) {
    return { action: 'acknowledge', order: prior.order, prompt: `You’re very welcome! Shall we continue?`, confidence: 1.0 }
  }

  // direct category mention
  const cat = MENU_V2.find((c) => lower.includes(c.name.toLowerCase()))
  if (cat) {
    return { action: 'choose_category', category: cat.name, order: prior.order, prompt: promptForItem(cat.name), confidence: 0.9 }
  }

  // direct item mention
  for (const c of MENU_V2) {
    const item = c.items.find((i) => lower.includes(i.name.toLowerCase()))
    if (item) {
      const groups = listModifierGroups(item)
      if (!groups.length) {
        const order = {
          ...prior.order,
          items: [...(prior.order.items || []), { category: c.name, name: item.name, basePrice: item.price, price: item.price, quantity: 1 }],
        }
        const { total } = computeTotals(order, prior.appliedDiscounts)
        return { action: 'collecting', order, prompt: `Added ${item.name}. Your total is ${total.toFixed(2)} dollars. Anything else?`, confidence: 0.9 }
      }
      return { action: 'choose_item', category: c.name, item: item.name, order: prior.order, prompt: promptForModifiers(item, groups), confidence: 0.9 }
    }
  }

  return null
}

/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Lambda handler
 * ──────────────────────────────────────────────────────────────────────────────
 */
export const handler = async (event: any) => {
  const path = event.path
  const params = new URLSearchParams(event.body || '')
  const callSid = params.get('CallSid')!
  const speech = (params.get('SpeechResult') || '').trim()
  console.log('callSid=', callSid, 'path=', path, 'speech=', speech)

  const twiml = new twimlVoice.VoiceResponse()

  if (path.endsWith('/voice')) {
    console.log('Starting new call session for', callSid)
    const initialSession: SessionState = {
      order: { items: [] },
      phase: 'choose_category',
      conversationHistory: [],
      appliedDiscounts: [],
    }
    console.log('Initial session state:', initialSession)
    await putSession(callSid, initialSession)
    const gather = twiml.gather({ input: ['speech'], action: '/mahesh/gather', method: 'POST', speechTimeout: 'auto', voice: VOICE, language: 'en-IN' })
    gather.say(`Hi! Welcome to Demo Bites. I’m here to make ordering easy. ${promptForCategory()}`)
    return buildXmlResponse(twiml.toString())
  }

  if (path.endsWith('/gather')) {

    const prior: SessionState =
      (await getSession(callSid)) || ({ order: { items: [] }, phase: 'choose_category', conversationHistory: [], appliedDiscounts: [] } as SessionState)
    console.log('Prior session state:', prior)
    // 1) Phase-first deterministic routing (no AI)
    if (prior.phase === 'choose_category') {
      const cat = pickCategoryFrom(speech)
      console.log('Deterministic category pick:', cat)
      if (cat) {
        const ai = { action: 'choose_category', category: cat, order: prior.order, prompt: '' }
        console.log('Saving selected category:', cat)
        await putSession(callSid, { ...prior, selectedCategory: cat })
        const handler = actionHandlers['choose_category']
        const twimlResp = await handler(ai, (await getSession(callSid))!, twiml, callSid)
        return twimlResp
      }
    }

    if (prior.phase === 'choose_item') {
      const category = prior.selectedCategory
      console.log('Current category for item pick:', category)
      if (!category) {
        const ai = { action: 'choose_category', order: prior.order, prompt: '' }
        const handler = actionHandlers['choose_category']
        const twimlResp = await handler(ai, prior, twiml, callSid)
        return twimlResp
      }
      const item = pickItemFrom(category, speech)
      console.log('Deterministic item pick:', item)
      if (item) {
        const ai = { action: 'choose_item', category, item, order: prior.order, prompt: '' }
        const handler = actionHandlers['choose_item']
        const twimlResp = await handler(ai, prior, twiml, callSid)
        return twimlResp
      }
    }

    if (prior.phase === 'choose_modifiers') {
      const category = prior.selectedCategory
      const itemName = prior.selectedItem
      const pend = prior.pendingModifiers
      console.log('Current category/item for modifier pick:', category, itemName, pend)
      if (category && itemName && pend?.groupsLeft?.length) {
        const item = getItem(category, itemName)
        const currentGroup = pend.groupsLeft[0]
        const picked = item ? pickModifierChoicesFrom(item, currentGroup, speech) : []
        console.log('Deterministic modifier pick:', currentGroup, picked)
        const ai = { action: 'choose_modifiers', userText: speech, modifiers: { [currentGroup]: picked }, order: prior.order, prompt: '' }
        const handler = actionHandlers['choose_modifiers']
        const twimlResp = await handler(ai, prior, twiml, callSid)
        return twimlResp
      }
    }

    // 2) If deterministic didn’t catch it, use fast path + AI
    let ai = handleCommonQuery(speech, prior)
    console.log('Fast-path common query result:', ai)
    if (!ai) ai = await cachedAiUpdate({ userText: speech, prior })
    console.log('AI query result:', ai)

    // 3) Save minimal history and selection hints
    const updatedHistory = prior.conversationHistory?.slice(-1) || []
    updatedHistory.push({ role: 'user', content: speech })
    updatedHistory.push({ role: 'assistant', content: ai?.prompt })
    console.log('Updated conversation history:', updatedHistory)
    await putSession(callSid, {
      ...prior,
      order: ai?.order || prior.order,
      lastAiAction: ai?.action,
      conversationHistory: updatedHistory,
      selectedCategory: ai?.category || prior.selectedCategory,
      selectedItem: ai?.item || prior.selectedItem,
    })

    const handler = actionHandlers[ai?.action] || actionHandlers['unknown']
    return handler(ai, (await getSession(callSid))!, twiml, callSid)
  }

  if (path.endsWith('/confirm')) {
    console.log('In confirmation step for', callSid)
    const lower = (params.get('SpeechResult') || '').toLowerCase()
    console.log('User said:', lower)
    const session = await getSession(callSid)
    const orderData = session?.order ?? { items: [] }
    console.log('Order data at confirmation:', orderData)
    const { total } = computeTotals(orderData, session?.appliedDiscounts)
    console.log('Order total at confirmation:', total)

    const items = getOrderSummary(orderData)

    // if (lower.includes('yes') || lower.includes('confirm') || lower.includes('place order') || lower.includes('go ahead') || lower.includes('that\'s it') || lower.includes('done')) {
      twiml.say(`Done! Your order for ${items}, total ${total.toFixed(2)} dollars, is placed. Thanks so much for ordering with us—enjoy your meal!`)
      twiml.hangup()
      await sendOrderToPartner({order: orderData})
      // await deleteSession(callSid)
      return buildXmlResponse(twiml.toString())
    // }
    // if (lower.includes('no') || lower.includes('cancel') || lower.includes('stop')) {
    //   twiml.say(`No problem—I’ve cancelled that. If you change your mind later, I’m here to help.`)
    //   twiml.hangup()
    //   await deleteSession(callSid)
    //   return buildXmlResponse(twiml.toString())
    // }

    // const gather = twiml.gather({ input: ['speech'], action: '/mahesh/confirm', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    // gather.say(`To place your order of ${items} for ${total.toFixed(2)} dollars, just say “confirm”. If you’d like to stop, say “cancel”.`)
    // // const gather = twiml.gather({ input: ['speech'], action: '/mahesh/confirm', method: 'POST', speechTimeout: '1', language: 'en-IN', voice: VOICE })
    // // gather.say(`To place your order of ${items} for ${total.toFixed(2)} dollars, just say “confirm”. If you’d like to stop, say “cancel”.`)
    // return buildXmlResponse(twiml.toString())
  }

  return { statusCode: 404, body: 'Not Found' }
}




async function sendOrderToPartner(orderData: any) {
  console.log('order Data ', orderData)
  console.log(
    'Transformed order data:',
    JSON.stringify(transformOrder(orderData), null, 2)
  )

  const mydata = transformOrder(orderData)

  const storeId = '8059770'

  const baseURL = `https://partner-api-sit.stage.t2sonline.com/v1/stores/${storeId}/orders`

  const token =
    'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ1cm46Zm9vZGh1YjpwYXJ0bmVyLWFwaSIsImF1ZCI6InVybjpmb29kaHViOnBhcnRuZXItYXBpIiwidiI6IjIiLCJjaWQiOiIzNjFkYjQ2Zi0xZjlmLTQyYzItOWM3Yi0zNDA2Y2JlOGM3YTIiLCJzY29wZSI6InN0b3Jlcy5nZXQgbWVudS5nZXQgbWVudS51cGRhdGUgbWVudS5kZWxldGUgb3JkZXJzLmxpc3Qgb3JkZXJzLmdldCBkZWxpdmVyeS16b25lcy51cGRhdGUgb3JkZXJzLmNyZWF0ZSBvcmRlcnMudXBkYXRlIG9yZGVycy5hbWVuZCBvcmRlcnMuY2FuY2VsIG9yZGVycy5yZWZ1bmQgc3RvcmUuc3RhdHVzLnVwZGF0ZSBzdG9yZS5vcGVuaW5nLWhvdXJzLnVwZGF0ZSBzdG9yZXMuY3JlYXRlIGRyaXZlci5mdWxmaWxsbWVudC51cGRhdGUgc3RvcmVzLnVwZGF0ZSBkZWFscy5nZXQgZGVhbHMuY3JlYXRlIGRlYWxzLnVwZGF0ZSBkZWFscy5kZWxldGUiLCJleHAiOjE3NTk5OTU4OTMsIm5iZiI6MTc1NzQwMzg5MywiaWF0IjoxNzU3NDAzODkzLCJqdGkiOiI5NjkxNWRjYy05MDIzLTQ3MmQtYTk1NC1jMTM1MDJjMmQ1ZmMifQ.uLxayV_zDlga8SZa5pL7vuISMIgGDQgExsSE4WXVCUdp2I57zhqCeadNtpZYQsXlxjpqdvyeaQYuKWRAjA4kHQ'

  const requestConfig = {
    method: 'POST',
    url: baseURL,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: mydata,
  }

  try {
    const response = await axios(requestConfig)
    console.log('✅ Order sent successfully:', response.data)
    return response.data
  } catch (error: any) {
    console.error(
      '❌ Error sending order:',
      error.response?.data || error.message
    )
    throw error
  }
}


function transformOrder(order: any): any {
  const external_reference_id = `EXT-${Math.floor(Math.random() * 1_000_000)}`
  const aggregator_order_id = `AGG-${Math.floor(Math.random() * 1_000_000)}`

  let items = order?.order?.items
  if (!Array.isArray(items) || items.length === 0) {
    items = [
      { name: 'AI Item 1', price: 9.99, quantity: 1 },
      { name: 'AI Item 2', price: 4.99, quantity: 2 },
    ]
  }

  const subtotal = items.reduce(
    (sum: number, item: any) => sum + item.price * item.quantity,
    0
  )

  

  function buildAddons(modifiers: any): any[] {
    if (!modifiers) return []

    const addons: any[] = []
    let addonCounter = 1

    for (const [groupName, modifierList] of Object.entries(modifiers)) {
      for (const mod of modifierList as any[]) {
        addons.push({
          modifier_group_id: groupName,
          modifier_group_name: groupName,
          quantity: 1,
          id: `ADDON-${addonCounter++}`,
          name: mod.name,
          price: (mod.priceDelta ?? 0) * 100,
          addons: [],
        })
      }
    }
    return addons
  }

  return {
    notes: 'Order placed via AI voice assistant',
    external_reference_id,
    source: 'FOODHUB',
    fulfillment_type: 'COLLECTION',
    aggregator_order_id,
    friendly_id: 'ORD-0001',
    est_pick_up_time: new Date(Date.now() + 30 * 60000).toISOString(),
    placed_on: new Date().toISOString(),

    payment: {
      total: subtotal * 100,
      payment_type: 'CASH',
      charges: {
        surcharge: 0,
        small_order_charge: 0,
        delivery_fee: 0,
        tip_for_restaurant: 0,
        carry_bags_charge: 0,
        service_fee: 0,
        other_charge: 0,
        tax: 0,
        driver_tips: 0,
        package_charge: 0,
      },
      discounts: [
        {
          discount_value: 0,
          discount_percentage: 0,
          discount_type: 'FIXED_AMOUNT',
        },
      ],
      subtotal: subtotal * 100,
      payment_status: 'PAID',
    },

    utensils: true,

    items: items.map((item: any, idx: number) => ({
      quantity: item.quantity,
      notes: '',
      category_name: 'Food',
      addons: item.modifiers ? buildAddons(item.modifiers) : [],
      price: item.price * 100,
      name: item.name,
      id: `ITEM-${idx + 1}`,
    })),

    total_carry_bags: 0,

    customer: {
      phone: '441782444282',
      last_name: 'Customer',
      first_name: 'FOODHUB AI',
      email: 'foodhubCustomer@example.com',
      phone_code: '14428',
    },
  }
}