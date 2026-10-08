/**
 * ARIA Quote Rotator — short famous quotes cycled through the sidebar
 * widget, one per minute. Kept as data (no DOM here) so it's unit-testable;
 * rendering + timing live in main.js.
 */

export const QUOTES = [
  { text: 'The best way to predict the future is to invent it.', author: 'Alan Kay' },
  { text: 'Simplicity is the soul of efficiency.', author: 'Austin Freeman' },
  { text: 'Stay hungry, stay foolish.', author: 'Steve Jobs' },
  { text: 'What we think, we become.', author: 'Buddha' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Imagination is more important than knowledge.', author: 'Albert Einstein' },
  { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { text: 'Action is the foundational key to all success.', author: 'Pablo Picasso' },
  { text: 'Whether you think you can or you think you can’t, you’re right.', author: 'Henry Ford' },
  { text: 'The journey of a thousand miles begins with a single step.', author: 'Lao Tzu' },
  { text: 'I have not failed. I’ve just found 10,000 ways that won’t work.', author: 'Thomas Edison' },
  { text: 'Strive not to be a success, but rather to be of value.', author: 'Albert Einstein' },
  { text: 'Small deeds done are better than great deeds planned.', author: 'Peter Marshall' },
  { text: 'Discipline is choosing what you want most over what you want now.', author: 'Abraham Lincoln' },
  { text: 'The future depends on what you do today.', author: 'Mahatma Gandhi' }
];

/**
 * Next index in the rotation (wraps around, never repeats until a full
 * cycle completes — sequential, not random).
 */
export function nextQuoteIndex(current) {
  if (!QUOTES.length) return 0;
  return (Number(current) + 1 + QUOTES.length) % QUOTES.length;
}
