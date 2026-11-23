// Ranks, crest tiers and the XP curve, shared by the desktop, web and Android apps.
// Levels 1-16 and their names are exactly what they were before 0.7.0 (nobody deranks):
// the same XP curve, the same eight names per theme, two levels each. 0.7.0 adds names for
// levels 17-100, more crest tiers after Mythic, and stops the climb at level 100.
(function () {
  const MAX_LEVEL = 100;
  const xpForLevel = (lvl) => 100 + (lvl - 1) * 50;   // unchanged since 0.1

  const OLD = {   // levels 1-16, two levels per name (the pre-0.7.0 list, do not change)
    tavern: ['Tavern Squire', 'Road Wanderer', 'Hedge Knight', 'Guild Adventurer', 'Dragon Botherer', 'Realm Champion', 'Living Legend', 'Myth Incarnate'],
    abyss:  ['Shallow Shrimp', 'Reef Diver', 'Kelp Ranger', 'Trench Explorer', 'Kraken Wrangler', 'Tide Sovereign', 'Abyssal Legend', 'Leviathan'],
  };
  const NEW = {   // levels 17-98, two levels per name
    tavern: [
      'Goblin Ambassador', 'Bard of Forbidden Ballads', 'Wyrm Whisperer', 'Lich Landlord', 'Archmage of Mild Chaos',
      'Duke of a Thousand Doors', 'Phoenix Rider', 'Hydra Head Collector', 'Titan Tickler', 'Warlord of the Ninth Tankard',
      'Dragonslayer Emeritus', 'Crown Juggler', 'Demon Accountant', 'Spellforged Juggernaut', 'Sorcerer Supreme of Snacks',
      "Grim Reaper's Drinking Buddy", 'Mountain Puncher', 'Archon of the Endless Tab', 'Weaver of Fate', 'Kingmaker',
      'Storm Emperor', 'Moon Breaker', 'Dragon Emperor', 'Lord of the Seven Realms', 'Walking Apocalypse',
      'Sun Eater', 'Herald of the Last Quest', 'Starforged Overlord', 'Keeper of the Infinite Scroll', 'Void Knight',
      'Time Bender', 'Pantheon Crasher', 'Demigod of Done', 'Worldsmith', 'Cosmic Tavern Keeper',
      'Eater of Deadlines', 'Ascended Legend', 'Architect of Myths', 'The Unkillable', 'Quest God',
      'Beyond Mortal Tally',
    ],
    abyss: [
      'Anglerfish Ambassador', 'Siren Choir Leader', 'Bioluminescent Baron', 'Shipwreck Landlord', 'Megalodon Mentor',
      'Coral Overlord', 'Black Smoker Warlock', 'Hydrothermal Hermit King', 'Giant Squid Wrestler', 'Pressure-Proof Prophet',
      'Sunken Crown Bearer', 'Trench Tyrant', 'Whale Fall Archon', 'Tsunami Architect', 'Abyssal Admiral',
      "Kraken's Landlord", 'Moon Tide Puller', 'Deep One Diplomat', 'Riftwalker of the Seafloor', "Poseidon's Rival",
      'Maelstrom Emperor', "Drowned God's Roommate", 'Mariana Monarch', 'Lord of the Seven Seas', 'Walking Tsunami',
      'Sunless Sovereign', 'Herald of the Hadal Zone', 'Star-Spawn Overlord', 'Keeper of the Last Pearl', 'Void Current',
      'Tide of Ages', 'Sea God Slayer', 'Demigod of the Depths', 'Planet Drowner', 'Cosmic Jellyfish',
      'Eater of Shipwrecks', 'Ascended Leviathan', 'Architect of the Abyss', 'The Unsinkable', 'Ocean God',
      'Deeper Than Deep',
    ],
  };
  const LAST = { tavern: ['The Final Boss', 'The One Who Finished Everything'], abyss: ['The Final Kraken', 'The Ocean Itself'] };

  function rankName(level, theme) {
    const t = OLD[theme] ? theme : 'tavern';
    const lv = Math.max(1, Math.min(MAX_LEVEL, level | 0));
    if (lv <= 16) return OLD[t][Math.floor((lv - 1) / 2)];
    if (lv <= 98) return NEW[t][Math.floor((lv - 17) / 2)];
    return LAST[t][lv - 99];
  }

  // Crest tiers: Bronze to Mythic are unchanged; 0.7.0 adds the ones after level 30.
  const TIERS = [
    { name: 'Bronze', from: 1, a: '#ffd2a1', b: '#9a5320', glow: 'rgba(240,150,80,.55)' },
    { name: 'Silver', from: 4, a: '#ffffff', b: '#8494a8', glow: 'rgba(220,235,255,.6)' },
    { name: 'Gold', from: 7, a: '#fff4b0', b: '#c88a10', glow: 'rgba(255,205,60,.7)' },
    { name: 'Emerald', from: 10, a: '#c4ffe0', b: '#0f8a4c', glow: 'rgba(60,230,140,.65)' },
    { name: 'Sapphire', from: 13, a: '#cfe6ff', b: '#1f50c8', glow: 'rgba(80,150,255,.75)' },
    { name: 'Ruby', from: 16, a: '#ffd0d6', b: '#b0142e', glow: 'rgba(255,60,90,.7)' },
    { name: 'Amethyst', from: 19, a: '#f0dcff', b: '#7027b8', glow: 'rgba(180,90,255,.75)' },
    { name: 'Diamond', from: 22, a: '#ffffff', b: '#6fd3ff', glow: 'rgba(190,240,255,.9)' },
    { name: 'Mythic', from: 26, a: '#fff0b0', b: '#ff3fd0', glow: 'rgba(255,120,220,.9)' },
    { name: 'Celestial', from: 30, a: '#f4fbff', b: '#7aa8ff', glow: 'rgba(170,205,255,.95)' },
    { name: 'Obsidian', from: 35, a: '#b9a6d9', b: '#16101f', glow: 'rgba(150,90,255,.85)' },
    { name: 'Starforged', from: 40, a: '#fff8d6', b: '#3a3f8f', glow: 'rgba(255,240,170,.95)' },
    { name: 'Void', from: 45, a: '#d6c2ff', b: '#0a0614', glow: 'rgba(120,60,255,.95)' },
    { name: 'Solar', from: 50, a: '#fffbe0', b: '#ff8a00', glow: 'rgba(255,170,40,1)' },
    { name: 'Prismatic', from: 55, a: '#ffffff', b: '#ff5fd2', glow: 'rgba(255,255,255,.95)' },
    { name: 'Astral', from: 60, a: '#e8f4ff', b: '#2a6dff', glow: 'rgba(120,190,255,1)' },
    { name: 'Eldritch', from: 65, a: '#c8ffd8', b: '#1a3d2a', glow: 'rgba(80,255,160,.95)' },
    { name: 'Cosmic', from: 70, a: '#ffe0ff', b: '#4b1a8a', glow: 'rgba(230,120,255,1)' },
    { name: 'Primordial', from: 75, a: '#ffe2c4', b: '#8a2a0a', glow: 'rgba(255,110,40,1)' },
    { name: 'Infinite', from: 80, a: '#ffffff', b: '#00c2ff', glow: 'rgba(120,240,255,1)' },
    { name: 'Godforged', from: 85, a: '#fffbe8', b: '#d4a017', glow: 'rgba(255,225,120,1)' },
    { name: 'Transcendent', from: 90, a: '#ffffff', b: '#b8a0ff', glow: 'rgba(255,255,255,1)' },
    { name: 'Ascendant', from: 95, a: '#fff6fb', b: '#ff2f6d', glow: 'rgba(255,120,170,1)' },
    { name: 'Omega', from: 100, a: '#ffffff', b: '#111111', glow: 'rgba(255,255,255,1)' },
  ];
  const tierIndex = (level) => { let i = 0; TIERS.forEach((t, j) => { if (level >= t.from) i = j; }); return i; };
  const tierColors = (t) => [t.a, t.b, '#ffffff', t.b, '#ffd36b'];

  function levelInfo(xp) {
    let lvl = 1, rem = Math.max(0, xp || 0);
    while (lvl < MAX_LEVEL && rem >= xpForLevel(lvl)) { rem -= xpForLevel(lvl); lvl++; }
    const max = lvl >= MAX_LEVEL;
    return { level: lvl, into: rem, need: xpForLevel(lvl), max };
  }

  window.Ranks = { MAX_LEVEL, xpForLevel, levelInfo, rankName, TIERS, tierIndex, tierColors };
})();
