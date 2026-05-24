'use strict';

const SYSTEM = `You are the memory extractor for a Minecraft AI companion.
Detect if the player's message defines, names, or modifies a saved location.

Location types: house, ai_home, farm, storage, village, danger, building, animal_pen, waypoint, poi, bed, workstation
Owner values: player, ai, neutral

Respond ONLY with valid JSON — no markdown, no extra text.
If no memory action: {"action":"none","confidence":0}

{
  "action":"save"|"forget"|"rename"|"update"|"none",
  "name":"location name or null",
  "type":"type or null",
  "owner":"player|ai|neutral|null",
  "useCurrentPosition":true|false,
  "notes":"extra context or null",
  "renameTo":"new name or null",
  "confidence":0.0-1.0
}`;

class MemoryParser {
  constructor(config, llmRouter = null) {
    this.config = config;
    this.router = llmRouter;
  }

  async parse(message, username) {
    if (!message?.trim() || !this.router) return null;

    const raw = await this.router.complete(
      'memory',
      [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: `${username} says: "${message}"` },
      ],
      { temperature: 0.1, maxTokens: 80 }
    );

    if (!raw) return null;

    try {
      const clean  = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      if (parsed.action === 'none' || !parsed.action) return null;
      if ((parsed.confidence || 0) < 0.5) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

module.exports = MemoryParser;
