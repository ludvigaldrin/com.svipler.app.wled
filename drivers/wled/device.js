'use strict';

const Homey = require('homey');
const axios = require('axios');

class WLEDDevice extends Homey.Device {
  
  async onInit() {
    try {
      
      // Get device settings
      const settings = this.getSettings();
      
      // Check for IP address (support both 'ip' and 'address' for backwards compatibility)
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        this.error('No IP address set for WLED device');
        throw new Error('No IP address set for WLED device');
      }
      
      // Set default values for effect/palette/preset ranges
      this.maxEffectId = settings.fxcount ? parseInt(settings.fxcount) - 1 : 255;
      this.maxPaletteId = settings.palcount ? parseInt(settings.palcount) - 1 : 255;
      // Initialize capability values with defaults
      if (this.hasCapability('wled_effect') && !this.getCapabilityValue('wled_effect')) {
        await this.setCapabilityValue('wled_effect', "0").catch(this.error);
      }
      
      if (this.hasCapability('wled_palette') && !this.getCapabilityValue('wled_palette')) {
        await this.setCapabilityValue('wled_palette', "0").catch(this.error);
      }

      // -1 is WLED's "no preset", 0 is not a valid option
      if (this.hasCapability('wled_preset') && !this.getCapabilityValue('wled_preset')) {
        await this.setCapabilityValue('wled_preset', "-1").catch(this.error);
      }
      
      // Add light_temperature capability if it doesn't exist (for existing devices)
      if (!this.hasCapability('light_temperature')) {
        await this.addCapability('light_temperature').catch(this.error);
      }
      
      // light_mode tells Homey's color picker whether the light is showing a
      // color or a white temperature. Without it the temperature slider has no
      // effect in the UI.
      if (!this.hasCapability('light_mode')) {
        await this.addCapability('light_mode').catch(this.error);
      }
      
      if (this.hasCapability('light_mode') && !this.getCapabilityValue('light_mode')) {
        await this.setCapabilityValue('light_mode', 'color').catch(this.error);
      }
      
      if (this.hasCapability('light_temperature') && !this.getCapabilityValue('light_temperature')) {
        await this.setCapabilityValue('light_temperature', 0.5).catch(this.error);
      }
      
      if (this.hasCapability('light_hue') && !this.getCapabilityValue('light_hue')) {
        await this.setCapabilityValue('light_hue', 0).catch(this.error);
      }
      
      if (this.hasCapability('light_saturation') && !this.getCapabilityValue('light_saturation')) {
        await this.setCapabilityValue('light_saturation', 0).catch(this.error);
      }
      
      // Set up polling intervals
      this.lastStateUpdate = 0;
      this.pollingInterval = settings.polling_interval || 
        (settings.pollInterval ? settings.pollInterval * 1000 : 5000);
      
      // Flag to track whether we're already fetching effects and palettes
      this.fetchingEffectsAndPalettes = false;
      this.effectsAndPalettesFetched = false;
      
      // Error tracking for backoff strategy
      this.consecutiveErrors = 0;
      this.maxBackoffTime = 60000; // Maximum backoff time: 1 minute
      this.basePollingInterval = this.pollingInterval; // Save original polling interval
      
      // Make sure API client is properly configured on each operation
      // Start with immediate state update with a shorter timeout
      setTimeout(() => this.updateDeviceState(), 1000);
      
      // Set up regular polling
      this.scheduleNextPoll();
      
      // Register all capability listeners
      this.registerCapabilityListeners();
      
      // Initialize effects, palettes and presets for selection after a short delay
      setTimeout(() => {
        this.fetchEffectsAndPalettes().catch(error => {
          this.error('Error initializing effects and palettes:', error);
        });
      }, 2000);

    } catch (error) {
      this.error(`Device initialization failed: ${error.message || error}`);
    }
  }
  
  // Register all capability listeners
  registerCapabilityListeners() {
    // On/off capability
    this.registerCapabilityListener('onoff', async (value) => {
      try {
        await this._post('/json/state', { on: value });
        
        return true;
      } catch (error) {
        this.error(`Error setting on/off: ${error.message}`);
        throw error;
      }
    });
    
    // Dimmer capability
    this.registerCapabilityListener('dim', async (value) => {
      try {
        // Convert 0-1 to 0-255 brightness. Dimming above zero also switches the
        // device on - setting bri while WLED is off has no visible effect, which
        // made flows that only dim look like they did nothing.
        await this._post('/json/state', {
          bri: Math.round(value * 255),
          on: value > 0
        });
        
        return true;
      } catch (error) {
        this.error(`Error setting brightness: ${error.message}`);
        throw error;
      }
    });
    
    // Color capabilities
    this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], async (valueObj) => {
      try {
        // Get current values if not changed
        const hue = valueObj.light_hue !== undefined ? valueObj.light_hue : this.getCapabilityValue('light_hue');
        const saturation = valueObj.light_saturation !== undefined ? valueObj.light_saturation : this.getCapabilityValue('light_saturation');
        
        await this._applyColor(hue || 0, saturation || 0);
        
        return true;
      } catch (error) {
        this.error(`Error setting color: ${error.message}`);
        throw error;
      }
    }, 500);
    
    // Color temperature capability
    this.registerCapabilityListener('light_temperature', async (value) => {
      try {
        await this._applyTemperature(value);
        
        return true;
      } catch (error) {
        this.error(`Error setting color temperature: ${error.message}`);
        throw error;
      }
    });
    
    // Light mode capability - re-applies whichever of the two the user switched to
    this.registerCapabilityListener('light_mode', async (value) => {
      try {
        if (value === 'temperature') {
          const temperature = this.getCapabilityValue('light_temperature');
          await this._applyTemperature(temperature === null ? 0.5 : temperature);
        } else {
          await this._applyColor(
            this.getCapabilityValue('light_hue') || 0,
            this.getCapabilityValue('light_saturation') || 0
          );
        }
        
        return true;
      } catch (error) {
        this.error(`Error setting light mode: ${error.message}`);
        throw error;
      }
    });
    
    // Effect capability
    this.registerCapabilityListener('wled_effect', async (value) => {
      try {
        await this._applyEffect(value);
        
        return true;
      } catch (error) {
        // Rethrow instead of returning false, otherwise the failure is silently
        // swallowed and the UI looks like the change went through
        this.error(`Error setting effect: ${error.message}`);
        throw error;
      }
    });
    
    // Palette capability
    this.registerCapabilityListener('wled_palette', async (value) => {
      try {
        await this._applyPalette(value);
        
        return true;
      } catch (error) {
        this.error(`Error setting palette: ${error.message}`);
        throw error;
      }
    });

    // Preset capability
    this.registerCapabilityListener('wled_preset', async (value) => {
      try {
        await this._applyPreset(value);
        
        return true;
      } catch (error) {
        this.error(`Error setting preset: ${error.message}`);
        throw error;
      }
    });
  }
  
  // Schedule next poll with exponential backoff if needed
  scheduleNextPoll() {
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
    }
    
    // Calculate backoff time based on consecutive errors
    let interval = this.basePollingInterval;
    if (this.consecutiveErrors > 0) {
      // Exponential backoff: 2^consecutiveErrors * baseInterval, capped at maxBackoffTime
      interval = Math.min(
        this.basePollingInterval * Math.pow(2, this.consecutiveErrors - 1),
        this.maxBackoffTime
      );
    }
    
    this.pollTimer = this.homey.setTimeout(() => this.updateDeviceState(), interval);
  }
  
  // Set an effect by ID - called from flow card action
  async setEffect(effectId) {
    if (effectId === undefined || effectId === null) {
      throw new Error('No effect ID provided');
    }
    
    await this._applyEffect(effectId);
    await this.setCapabilityValue('wled_effect', String(effectId)).catch(this.error);
    
    return true;
  }
  
  // Set a palette by ID - called from flow card action
  async setPalette(paletteId) {
    if (paletteId === undefined || paletteId === null) {
      throw new Error('No palette ID provided');
    }
    
    await this._applyPalette(paletteId);
    await this.setCapabilityValue('wled_palette', String(paletteId)).catch(this.error);
    
    return true;
  }
  
  // Set a preset by ID - called from flow card action
  async setPreset(presetId) {
    if (presetId === undefined || presetId === null) {
      throw new Error('No preset ID provided');
    }
    
    await this._applyPreset(presetId);
    await this.setCapabilityValue('wled_preset', String(presetId)).catch(this.error);
    
    return true;
  }
  
  // Apply an effect to the device, shared by the capability listener and the flow action
  async _applyEffect(effectId) {
    const id = parseInt(effectId, 10);
    
    if (isNaN(id) || id < 0 || id > this.maxEffectId) {
      throw new Error(`Invalid effect ID: ${effectId}. Must be between 0 and ${this.maxEffectId}`);
    }
    
    await this._applyToSegments({ fx: id });
  }
  
  // Apply a palette to the device, shared by the capability listener and the flow action
  async _applyPalette(paletteId) {
    const id = parseInt(paletteId, 10);
    
    if (isNaN(id) || id < 0 || id > this.maxPaletteId) {
      throw new Error(`Invalid palette ID: ${paletteId}. Must be between 0 and ${this.maxPaletteId}`);
    }
    
    await this._applyToSegments({ pal: id });
  }
  
  // Apply a preset to the device, shared by the capability listener and the flow action
  async _applyPreset(presetId) {
    const id = parseInt(presetId, 10);
    
    if (isNaN(id)) {
      throw new Error(`Invalid preset ID: ${presetId}`);
    }
    
    if (id !== -1) {
      if (id < 1) {
        throw new Error(`Invalid preset ID: ${id}. Must be -1 (no preset) or 1 and up`);
      }
      
      // WLED silently ignores a preset that does not exist, which made flows
      // look like they ran fine while nothing happened on the strip
      const available = await this._getAvailablePresets();
      
      if (available.length === 0) {
        throw new Error('This device has no presets saved. Create one in the WLED interface first.');
      }
      
      if (!available.some(preset => preset.id === String(id))) {
        throw new Error(`Preset ${id} does not exist on this device. Available presets: ${available.map(preset => preset.id).join(', ')}`);
      }
    }
    
    await this._post('/json/state', { ps: id });
  }
  
  // List the segments defined on the device, for the segment flow cards
  async getSegmentsList(query = '') {
    try {
      const state = await this._get('/json/state');
      const segments = Array.isArray(state && state.seg) ? state.seg : [];
      
      const list = segments.map((segment, index) => {
        const id = segment && segment.id !== undefined ? segment.id : index;
        const name = String((segment && segment.n) || '').trim();
        const range = segment && segment.stop > segment.start
          ? `LED ${segment.start}-${segment.stop - 1}`
          : 'empty';
        
        return {
          id: String(id),
          name: `${name || `Segment ${id}`} (${range})`
        };
      });
      
      return this._filterByQuery(list, query);
    } catch (error) {
      this.error('Error getting segments list:', error);
      return [];
    }
  }
  
  async setSegmentEffect(segmentId, effectId) {
    const id = this._parseSegmentId(segmentId);
    const effect = parseInt(effectId, 10);
    
    if (isNaN(effect) || effect < 0 || effect > this.maxEffectId) {
      throw new Error(`Invalid effect ID: ${effectId}. Must be between 0 and ${this.maxEffectId}`);
    }
    
    await this._post('/json/state', { seg: [{ id, fx: effect }] });
    
    return true;
  }
  
  async setSegmentPalette(segmentId, paletteId) {
    const id = this._parseSegmentId(segmentId);
    const palette = parseInt(paletteId, 10);
    
    if (isNaN(palette) || palette < 0 || palette > this.maxPaletteId) {
      throw new Error(`Invalid palette ID: ${paletteId}. Must be between 0 and ${this.maxPaletteId}`);
    }
    
    await this._post('/json/state', { seg: [{ id, pal: palette }] });
    
    return true;
  }
  
  async setSegmentColor(segmentId, color) {
    const id = this._parseSegmentId(segmentId);
    const rgb = this._parseColor(color);
    const lightCapabilities = await this._getLightCapabilities();
    
    const col = (lightCapabilities & 2)
      ? [rgb.r, rgb.g, rgb.b, 0]
      : [rgb.r, rgb.g, rgb.b];
    
    await this._post('/json/state', { seg: [{ id, col: [col] }] });
    
    return true;
  }
  
  async setSegmentBrightness(segmentId, value) {
    const id = this._parseSegmentId(segmentId);
    const brightness = Math.round(Math.max(0, Math.min(1, value)) * 255);
    
    await this._post('/json/state', { seg: [{ id, bri: brightness, on: brightness > 0 }] });
    
    return true;
  }
  
  async setSegmentPower(segmentId, on) {
    const id = this._parseSegmentId(segmentId);
    
    await this._post('/json/state', { seg: [{ id, on: !!on }] });
    
    // The set of active segments just changed
    this._segmentIds = null;
    
    return true;
  }
  
  // Step to the next or previous preset saved on the device, wrapping around
  async cyclePreset(direction = 1) {
    const presets = await this._getAvailablePresets(true);
    
    if (presets.length === 0) {
      throw new Error('This device has no presets saved. Create one in the WLED interface first.');
    }
    
    const current = String(this.getCapabilityValue('wled_preset'));
    const currentIndex = presets.findIndex(preset => preset.id === current);
    
    // With no preset active, stepping forward starts at the first preset and
    // stepping backward starts at the last
    const nextIndex = currentIndex === -1
      ? (direction > 0 ? 0 : presets.length - 1)
      : (currentIndex + direction + presets.length) % presets.length;
    
    const next = presets[nextIndex];
    
    await this._applyPreset(next.id);
    await this.setCapabilityValue('wled_preset', next.id).catch(this.error);
    
    return next;
  }
  
  // Set a capability value and fire the matching trigger when it actually
  // changed, so flows also react to changes made in the WLED interface itself
  async _setAndTrigger(capability, value, triggerId, tokenName) {
    const previous = this.getCapabilityValue(capability);
    
    await this.setCapabilityValue(capability, value).catch(this.error);
    
    // Don't fire on the very first reading after a restart
    if (previous === null || previous === undefined || previous === value) {
      return;
    }
    
    try {
      const label = await this._getOptionTitle(capability, value);
      
      await this.homey.flow.getDeviceTriggerCard(triggerId).trigger(this, {
        [tokenName]: label,
        [`${tokenName}_id`]: parseInt(value, 10)
      });
    } catch (error) {
      this.error(`Could not fire trigger ${triggerId}: ${error.message}`);
    }
  }
  
  // Human readable name for a capability option id
  async _getOptionTitle(capability, id) {
    try {
      const options = await this.getCapabilityOptions(capability);
      const match = options && options.values
        ? options.values.find(option => option.id === String(id))
        : null;
      
      if (match) {
        if (match.title && typeof match.title === 'object') {
          return match.title.en || String(id);
        }
        
        return match.title || match.name || String(id);
      }
    } catch (error) {
      // Fall through to the raw id
    }
    
    return String(id);
  }
  
  _parseSegmentId(segmentId) {
    const id = parseInt(segmentId, 10);
    
    if (isNaN(id) || id < 0) {
      throw new Error(`Invalid segment: ${segmentId}`);
    }
    
    return id;
  }
  
  // Homey's color flow argument arrives as a hex string, but accept an
  // {r,g,b} object and an {hue,saturation} pair too
  _parseColor(color) {
    if (typeof color === 'string') {
      const hex = color.replace('#', '').trim();
      
      if (/^[0-9a-fA-F]{6}$/.test(hex)) {
        return {
          r: parseInt(hex.substring(0, 2), 16),
          g: parseInt(hex.substring(2, 4), 16),
          b: parseInt(hex.substring(4, 6), 16)
        };
      }
      
      // Some Homey versions hand over a 0-1 hue as a numeric string
      const hue = parseFloat(hex);
      if (!isNaN(hue)) {
        return this._hsvToRgb(Math.max(0, Math.min(1, hue)), 1, 1);
      }
    }
    
    if (color && typeof color === 'object') {
      if (color.r !== undefined) {
        return { r: color.r, g: color.g, b: color.b };
      }
      
      if (color.hue !== undefined) {
        return this._hsvToRgb(color.hue, color.saturation === undefined ? 1 : color.saturation, 1);
      }
    }
    
    if (typeof color === 'number') {
      return this._hsvToRgb(Math.max(0, Math.min(1, color)), 1, 1);
    }
    
    throw new Error(`Could not read the color value: ${JSON.stringify(color)}`);
  }
  
  _filterByQuery(list, query) {
    if (!query) {
      return list;
    }
    
    const lcQuery = String(query).toLowerCase();
    return list.filter(item => item.name.toLowerCase().includes(lcQuery));
  }
  
  async getEffectsList(query = '') {
    try {
      // Get effects from capability options instead of storing separately
      const effectOptions = await this.getCapabilityOptions('wled_effect');
      
      if (!effectOptions || !effectOptions.values || effectOptions.values.length === 0) {
        await this.fetchEffectsAndPalettes();
        const updatedOptions = await this.getCapabilityOptions('wled_effect');
        return this.formatOptionsForFlowCard(updatedOptions.values);
      }
      
      // Convert capability options to flow card format
      const flowCardOptions = this.formatOptionsForFlowCard(effectOptions.values);
      
      // Filter by query if provided
      if (query && query.length > 0) {
        const lcQuery = query.toLowerCase();
        return flowCardOptions.filter(option => 
          option.name.toLowerCase().includes(lcQuery)
        );
      }
      
      return flowCardOptions;
    } catch (error) {
      this.error('Error getting effects list:', error);
      
      // Create options from default effects
      return this._getDefaultEffects().map((name, id) => ({
        id: String(id),
        name: name
      }));
    }
  }
  
  async getPalettesList(query = '') {
    try {
      // Get palettes from capability options instead of storing separately
      const paletteOptions = await this.getCapabilityOptions('wled_palette');
      
      if (!paletteOptions || !paletteOptions.values || paletteOptions.values.length === 0) {
        await this.fetchEffectsAndPalettes();
        const updatedOptions = await this.getCapabilityOptions('wled_palette');
        return this.formatOptionsForFlowCard(updatedOptions.values);
      }
      
      // Convert capability options to flow card format
      const flowCardOptions = this.formatOptionsForFlowCard(paletteOptions.values);
      
      // Filter by query if provided
      if (query && query.length > 0) {
        const lcQuery = query.toLowerCase();
        return flowCardOptions.filter(option => 
          option.name.toLowerCase().includes(lcQuery)
        );
      }
      
      return flowCardOptions;
    } catch (error) {
      this.error('Error getting palettes list:', error);
      
      // Create options from default palettes
      return this._getDefaultPalettes().map((name, id) => ({
        id: String(id),
        name: name
      }));
    }
  }
  
  async getPresetsList(query = '') {
    try {
      // Get presets from capability options
      const presetOptions = await this.getCapabilityOptions('wled_preset');
      
      if (!presetOptions || !presetOptions.values || presetOptions.values.length === 0) {
        await this.fetchEffectsAndPalettes();
        const updatedOptions = await this.getCapabilityOptions('wled_preset');
        return this.formatOptionsForFlowCard(updatedOptions.values);
      }
      
      // Convert capability options to flow card format
      const flowCardOptions = this.formatOptionsForFlowCard(presetOptions.values);
      
      // Filter by query if provided
      if (query && query.length > 0) {
        const lcQuery = query.toLowerCase();
        return flowCardOptions.filter(option => 
          option.name.toLowerCase().includes(lcQuery)
        );
      }
      
      return flowCardOptions;
    } catch (error) {
      this.error('Error getting presets list:', error);
      
      return [{ id: '-1', name: 'No Preset' }];
    }
  }
  
  // Helper method to convert capability option format to flow card format
  formatOptionsForFlowCard(options) {
    return options.map(option => {
      // Handle options with title object
      if (option.title && typeof option.title === 'object') {
        return {
          id: option.id,
          name: option.title.en || `Option ${option.id}`
        };
      }
      // Handle options with string title
      else if (option.title && typeof option.title === 'string') {
        return {
          id: option.id,
          name: option.title
        };
      }
      // Handle options with name property
      else if (option.name) {
        return option;
      }
      // Fallback
      else {
        return {
          id: option.id,
          name: `Option ${option.id}`
        };
      }
    });
  }
  
  // Core method to fetch and update device state
  async updateDeviceState() {
    try {
      // Get IP address from settings
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      
      if (!ipAddress) {
        this.error('No IP address in settings, cannot update state');
        await this.setUnavailable('No IP address configured');
        return;
      }
      
      // Get state from WLED API
      const response = { data: await this._get('/json/state') };
      
      if (!response || !response.data) {
        this.error('Invalid response from WLED API');
        await this.setUnavailable('Invalid response from device');
        // Increase consecutive error count
        this.consecutiveErrors++;
        this.scheduleNextPoll();
        return;
      }
      
      // If we get here, the device is available - reset error count
      this.consecutiveErrors = 0;
      this.setAvailable();
      
      const state = response.data;
      
      // Refresh the segment cache for free while we already have the state
      this._cacheSegmentIds(state);
      
      // Update device capabilities
      await this.setCapabilityValue('onoff', !!state.on).catch(this.error);
      
      if (state.bri !== undefined) {
        await this.setCapabilityValue('dim', state.bri / 255).catch(this.error);
      }
      
      if (state.seg && state.seg[0]) {
        const segment = state.seg[0];
        
        // Determine whether the light is currently showing a color or white.
        // WLED reports white as RGB 0 with a non-zero white channel; on strips
        // without CCT hardware we emulate white on the RGB channels, so compare
        // against the last emulated white point as well.
        const col = segment.col && segment.col[0] ? segment.col[0] : null;
        const isWhite = !!col && (
          (col[0] === 0 && col[1] === 0 && col[2] === 0 && (col[3] || 0) > 0) ||
          (!!this._emulatedWhiteRgb &&
            col[0] === this._emulatedWhiteRgb.r &&
            col[1] === this._emulatedWhiteRgb.g &&
            col[2] === this._emulatedWhiteRgb.b)
        );
        
        if (this.hasCapability('light_mode')) {
          await this.setCapabilityValue('light_mode', isWhite ? 'temperature' : 'color').catch(this.error);
        }
        
        // Color values - skipped while the light is white, otherwise the white
        // color would reset hue and saturation on every poll
        if (col && !isWhite) {
          const hsv = this._rgbToHsv(col[0], col[1], col[2]);
          
          await this.setCapabilityValue('light_hue', hsv.h).catch(this.error);
          await this.setCapabilityValue('light_saturation', hsv.s).catch(this.error);
        }
        
        // Effect - use WLED's effect ID directly (0-based)
        if (segment.fx !== undefined) {
          if (segment.fx < 0 || segment.fx > this.maxEffectId) {
            this.log(`Effect ID ${segment.fx} out of range (max: ${this.maxEffectId})`);
          } else {
            await this._setAndTrigger('wled_effect', String(segment.fx), 'effect_changed', 'effect');
          }
        }
        
        // Palette - use WLED's palette ID directly (0-based)
        if (segment.pal !== undefined) {
          if (segment.pal < 0 || segment.pal > this.maxPaletteId) {
            this.log(`Palette ID ${segment.pal} out of range (max: ${this.maxPaletteId})`);
          } else {
            await this._setAndTrigger('wled_palette', String(segment.pal), 'palette_changed', 'palette');
          }
        }
      }
      
      // Color temperature capability. WLED's cct runs from 0 (warmest) to 255
      // (coldest) while Homey's light_temperature runs from 0 (coldest) to 1
      // (warmest), so the value has to be inverted.
      // Only hardware with real CCT channels reports a meaningful cct - on other
      // strips WLED keeps reporting its default and would overwrite the value
      // the user just set.
      if (this.hasCapability('light_temperature') && state.seg && state.seg[0] && state.seg[0].cct !== undefined) {
        const lightCapabilities = await this._getLightCapabilities();
        
        if (lightCapabilities & 4) {
          const tempValue = 1 - (state.seg[0].cct / 255);
          await this.setCapabilityValue('light_temperature', Math.max(0, Math.min(1, tempValue))).catch(this.error);
        }
      }
      
      // Preset. WLED reports 0 when no preset is active, Homey uses -1 for that.
      if (state.ps !== undefined) {
        try {
          const presetId = parseInt(state.ps, 10) > 0 ? String(state.ps) : '-1';
          
          let options = await this.getCapabilityOptions('wled_preset');
          let known = !!options && !!options.values && options.values.some(option => option.id === presetId);
          
          // A preset was added on the device that we don't know about yet
          if (!known && presetId !== '-1') {
            await this._updatePresetsCapability(await this._getAvailablePresets(true));
            
            options = await this.getCapabilityOptions('wled_preset');
            known = !!options && !!options.values && options.values.some(option => option.id === presetId);
          }
          
          if (known) {
            await this._setAndTrigger('wled_preset', presetId, 'preset_changed', 'preset');
          }
        } catch (presetError) {
          this.error(`Error handling preset state: ${presetError.message}`);
        }
      }
      
      // Update last state time
      this.lastStateUpdate = Date.now();
      
      // If we haven't fetched effects and palettes yet, do it now
      if (!this.effectsAndPalettesFetched && !this.fetchingEffectsAndPalettes) {
        this.fetchEffectsAndPalettes().catch(error => {
          this.error('Failed to fetch effects and palettes:', error.message);
        });
      }
      
      // Schedule next poll with normal interval
      this.scheduleNextPoll();
    } catch (error) {
      // Increment consecutive error count
      this.consecutiveErrors++;
      
      // Set device as unavailable if we get a connection error
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || 
          error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' ||
          error.code === 'EHOSTUNREACH') {
        this.error(`Connection error: ${error.message}`);
        await this.setUnavailable('Cannot connect to device');
      } else {
        this.error(`Error fetching device state: ${error.message || error}`);
      }
      
      // Schedule next poll with backoff
      this.scheduleNextPoll();
    }
  }
  
  // Helper methods for effects and palettes
  async fetchEffectsAndPalettes() {
    // Prevent multiple simultaneous fetch operations
    if (this.fetchingEffectsAndPalettes) {
      return false;
    }
    
    this.fetchingEffectsAndPalettes = true;
    
    try {
      // Get IP address from settings
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      
      if (!ipAddress) {
        this.error('No IP address in settings, cannot fetch effects and palettes');
        this.fetchingEffectsAndPalettes = false;
        // Don't throw, just handle gracefully
        await this._updateEffectsCapability(this._getDefaultEffects());
        await this._updatePalettesCapability(this._getDefaultPalettes());
        await this._updatePresetsCapability([]);
        return false;
      }
      
      // First get effects and palettes
      const data = await this._get('/json');
      
      // /json also carries the device info, so refresh the light capabilities here
      if (data && data.info) {
        this._storeLightCapabilities(data.info);
      }
      
      // Handle effects
      if (data && data.effects && Array.isArray(data.effects)) {
        // Update the maximum effect ID
        this.maxEffectId = data.effects.length - 1;
        
        // Update device capability options
        await this._updateEffectsCapability(data.effects);
      } else {
        await this._updateEffectsCapability(this._getDefaultEffects());
      }
      
      // Handle palettes
      if (data && data.palettes && Array.isArray(data.palettes)) {
        // Update the maximum palette ID
        this.maxPaletteId = data.palettes.length - 1;
        
        // Update device capability options
        await this._updatePalettesCapability(data.palettes);
      } else {
        await this._updatePalettesCapability(this._getDefaultPalettes());
      }
      
      // Now fetch presets separately
      await this._updatePresetsCapability(await this._getAvailablePresets(true));
      
      // Update device settings with the new counts
      const updatedSettings = {};
      let settingsChanged = false;
      
      // Ensure ip and address fields are both set
      if (!settings.ip && settings.address) {
        updatedSettings.ip = settings.address;
        settingsChanged = true;
      } else if (!settings.address && settings.ip) {
        updatedSettings.address = settings.ip;
        settingsChanged = true;
      }
      
      // Update effect and palette counts if they're different.
      // /json nests these under info - reading them off the root meant the
      // counts were never actually stored.
      const info = (data && data.info) || {};
      
      if (info.fxcount && settings.fxcount !== info.fxcount) {
        updatedSettings.fxcount = info.fxcount;
        settingsChanged = true;
      }
      
      if (info.palcount && settings.palcount !== info.palcount) {
        updatedSettings.palcount = info.palcount;
        settingsChanged = true;
      }
      
      if (settingsChanged) {
        await this.setSettings(updatedSettings);
      }
      
      // Mark as fetched to prevent duplicate fetches
      this.effectsAndPalettesFetched = true;
      this.fetchingEffectsAndPalettes = false;
      return true;
    } catch (error) {
      this.error(`Error fetching effects, palettes and presets: ${error.message}`);
      
      // Fall back to defaults if there's an error
      await this._updateEffectsCapability(this._getDefaultEffects());
      await this._updatePalettesCapability(this._getDefaultPalettes());
      await this._updatePresetsCapability([]);
      
      this.fetchingEffectsAndPalettes = false;
      return false;
    }
  }
  
  async _updateEffectsCapability(effects) {
    try {
      // Convert to format expected by capability options
      const effectOptions = effects.map((name, id) => ({
        id: String(id),  // Use direct 0-based indexing to match WLED
        name: name || `Effect ${id}`,
        title: {
          en: name || `Effect ${id}`
        }
      }));
      
      // Sort effects alphabetically by name, but keep "Solid" at the top
      effectOptions.sort((a, b) => {
        // Keep "Solid" at the top
        if (a.id === "0") return -1;
        if (b.id === "0") return 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      
      // Update the capability options
      await this.setCapabilityOptions('wled_effect', {
        values: effectOptions
      }).catch(err => this.error(`Failed to set effect options: ${err.message}`));
      
      return true;
    } catch (error) {
      this.error('Error updating effects capability:', error);
      return false;
    }
  }
  
  async _updatePalettesCapability(palettes) {
    try {
      // Convert to format expected by capability options
      const paletteOptions = palettes.map((name, id) => ({
        id: String(id),  // Use direct 0-based indexing to match WLED
        name: name || `Palette ${id}`,
        title: {
          en: name || `Palette ${id}`
        }
      }));
      
      // Sort palettes alphabetically by name, but keep "Default" at the top
      paletteOptions.sort((a, b) => {
        // Keep "Default" at the top
        if (a.id === "0") return -1;
        if (b.id === "0") return 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      
      // Update the capability options
      await this.setCapabilityOptions('wled_palette', {
        values: paletteOptions
      }).catch(err => this.error(`Failed to set palette options: ${err.message}`));
      
      return true;
    } catch (error) {
      this.error('Error updating palettes capability:', error);
      return false;
    }
  }
  
  async _updatePresetsCapability(presets) {
    try {
      // "No preset" is always available - WLED uses -1 to clear the active preset
      const presetOptions = [{ id: '-1', title: { en: 'No Preset' } }];
      
      // Only presets that actually exist on the device. Padding the list with
      // placeholder presets 1-10 used to make flows silently do nothing when the
      // chosen preset was never saved on the device.
      presets.forEach(preset => {
        presetOptions.push({
          id: String(preset.id),
          title: { en: preset.name || `Preset ${preset.id}` }
        });
      });
      
      await this.setCapabilityOptions('wled_preset', {
        values: presetOptions
      }).catch(err => this.error(`Failed to set preset options: ${err.message}`));
      
      // A preset that no longer exists must not stay selected
      const current = this.getCapabilityValue('wled_preset');
      if (current && !presetOptions.some(option => option.id === current)) {
        await this.setCapabilityValue('wled_preset', '-1').catch(this.error);
      }
      
      return true;
    } catch (error) {
      this.error('Error updating presets capability:', error);
      return false;
    }
  }
  
  // Default effects to use if API doesn't provide them
  _getDefaultEffects() {
    return [
      'Solid', 'Blink', 'Breathe', 'Wipe', 'Wipe Random', 'Random Colors', 'Sweep', 'Dynamic', 'Colorloop', 'Rainbow',
      'Scan', 'Dual Scan', 'Fade', 'Chase', 'Chase Rainbow', 'Running', 'Saw', 'Twinkle', 'Dissolve', 'Dissolve Rnd',
      'Sparkle', 'Dark Sparkle', 'Sparkle+', 'Strobe', 'Strobe Rainbow', 'Mega Strobe', 'Blink Rainbow', 'Android', 'Chase', 'Chase Random',
      'Chase Rainbow', 'Chase Flash', 'Chase Flash Rnd', 'Rainbow Runner', 'Colorful', 'Traffic Light', 'Sweep Random', 'Running 2', 'Red & Blue', 'Stream',
      'Scanner', 'Lighthouse', 'Fireworks', 'Rain', 'Merry Christmas', 'Fire Flicker', 'Gradient', 'Loading', 'In Out', 'In In',
      'Out Out', 'Out In', 'Circus', 'Halloween', 'Tri Chase', 'Tri Wipe', 'Tri Fade', 'Lightning', 'ICU', 'Multi Comet',
      'Dual Scanner', 'Stream 2', 'Oscillate', 'Pride 2015', 'Juggle', 'Palette', 'Fire 2012', 'Colorwaves', 'BPM', 'Fill Noise', 'Noise 1',
      'Noise 2', 'Noise 3', 'Noise 4', 'Colortwinkle', 'Lake', 'Meteor', 'Smooth Meteor', 'Railway', 'Ripple'
    ];
  }
  
  // Default palettes to use if API doesn't provide them
  _getDefaultPalettes() {
    return [
      'Default', 'Random Cycle', 'Primary Color', 'Based on Primary', 'Set Colors', 'Based on Set', 'Party', 'Cloud', 'Lava', 'Ocean',
      'Forest', 'Rainbow', 'Rainbow Bands', 'Sunset', 'Rivendell', 'Breeze', 'Red & Blue', 'Yellowout', 'Analogous', 'Splash',
      'Pastel', 'Sunset 2', 'Beech', 'Vintage', 'Departure', 'Landscape', 'Beach', 'Sherbet', 'Hult', 'Hult 64',
      'Drywet', 'Jul', 'Grintage', 'Rewhi', 'Tertiary', 'Fire', 'Icefire', 'Cyane', 'Light Pink', 'Autumn',
      'Magenta', 'Magred', 'Yelmag', 'Yelblu', 'Orange & Teal', 'Tiamat', 'April Night'
    ];
  }
  
  // Single place where the HTTP client is built, so address and timeout stay
  // consistent across every call
  _getApiClient(timeout = 5000) {
    const settings = this.getSettings();
    const ipAddress = settings.ip || settings.address;
    
    if (!ipAddress) {
      throw new Error('No IP address configured');
    }
    
    return axios.create({
      baseURL: `http://${ipAddress}`,
      timeout,
    });
  }
  
  async _get(path) {
    const response = await this._getApiClient().get(path);
    return response.data;
  }
  
  async _post(path, data) {
    const response = await this._getApiClient().post(path, data);
    return response.data;
  }
  
  // Apply a set of segment properties to every active segment.
  // WLED applies a segment object only to the segment it addresses, so writing
  // just seg[0] left every other segment on a multi-segment strip untouched.
  async _applyToSegments(props) {
    const segmentIds = await this._getActiveSegmentIds();
    
    return this._post('/json/state', {
      seg: segmentIds.map(id => Object.assign({ id }, props))
    });
  }
  
  // Ids of the segments that are enabled and actually cover LEDs
  async _getActiveSegmentIds() {
    const now = Date.now();
    
    // Cached briefly, otherwise every colour change costs an extra round trip
    if (this._segmentIds && (now - this._segmentIdsUpdatedAt) < 30000) {
      return this._segmentIds;
    }
    
    try {
      return this._cacheSegmentIds(await this._get('/json/state'));
    } catch (error) {
      this.error(`Could not read segments, falling back to segment 0: ${error.message}`);
      return [0];
    }
  }
  
  // Pick the active segment ids out of a /json/state payload and cache them
  _cacheSegmentIds(state) {
    let ids = [];
    
    if (state && Array.isArray(state.seg)) {
      ids = state.seg
        .map((segment, index) => ({
          segment,
          id: segment && segment.id !== undefined ? segment.id : index
        }))
        .filter(({ segment }) => segment && segment.stop > segment.start && segment.on !== false)
        .map(({ id }) => id);
    }
    
    if (ids.length === 0) {
      ids = [0];
    }
    
    this._segmentIds = ids;
    this._segmentIdsUpdatedAt = Date.now();
    
    return ids;
  }
  
  // Read the presets that actually exist on the device
  async _getAvailablePresets(forceRefresh = false) {
    const now = Date.now();
    
    if (!forceRefresh && this._presets && (now - this._presetsUpdatedAt) < 60000) {
      return this._presets;
    }
    
    try {
      const presets = this._parsePresets(await this._get('/presets.json'));
      
      this._presets = presets;
      this._presetsUpdatedAt = now;
      
      return presets;
    } catch (error) {
      this.error(`Could not read presets: ${error.message}`);
      return this._presets || [];
    }
  }
  
  // presets.json is keyed by preset id and holds empty objects for unused slots
  _parsePresets(presets) {
    if (!presets || typeof presets !== 'object') {
      return [];
    }
    
    return Object.entries(presets)
      .filter(([id, preset]) => preset
        && typeof preset === 'object'
        && Object.keys(preset).length > 0
        && !id.startsWith('_')
        && parseInt(id, 10) > 0)
      .map(([id, preset]) => {
        const name = String(preset.n || preset.name || '').trim();
        
        return {
          id: String(id),
          name: name || `Preset ${id}`
        };
      })
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  }
  
  // Apply a hue/saturation pair to the device
  async _applyColor(hue, saturation) {
    const rgb = this._hsvToRgb(hue, saturation, 1);
    const lightCapabilities = await this._getLightCapabilities();
    
    // Explicitly clear the white channel, otherwise the color stays washed out
    // after the light has been in temperature mode
    const col = (lightCapabilities & 2)
      ? [rgb.r, rgb.g, rgb.b, 0]
      : [rgb.r, rgb.g, rgb.b];
    
    this._emulatedWhiteRgb = null;
    
    await this._applyToSegments({ col: [col] });
    
    if (this.hasCapability('light_mode')) {
      await this.setCapabilityValue('light_mode', 'color').catch(this.error);
    }
  }
  
  // Apply a Homey light_temperature value to the device.
  // Homey runs from 0 (coldest) to 1 (warmest), WLED's cct is the other way
  // around, so the value is inverted here.
  async _applyTemperature(value) {
    const cct = Math.round((1 - value) * 255);
    const lightCapabilities = await this._getLightCapabilities();
    
    let col;
    
    if ((lightCapabilities & 4) || lightCapabilities === 2) {
      // Real white/CCT channels. The RGB channels have to be off and the white
      // channel has to be non-zero - with a white channel of 0 the CCT channels
      // stay dark and all that is visible is harsh RGB white, which is why the
      // light used to look cold no matter which temperature was selected.
      col = [0, 0, 0, 255];
      this._emulatedWhiteRgb = null;
    } else {
      // No CCT hardware. seg.cct has no physical effect on these strips, so the
      // white point is emulated on the RGB channels instead.
      const rgb = this._kelvinToRgb(this._temperatureToKelvin(value));
      col = (lightCapabilities & 2)
        ? [rgb.r, rgb.g, rgb.b, 0]
        : [rgb.r, rgb.g, rgb.b];
      this._emulatedWhiteRgb = rgb;
    }
    
    await this._applyToSegments({ col: [col], cct });
    
    if (this.hasCapability('light_mode')) {
      await this.setCapabilityValue('light_mode', 'temperature').catch(this.error);
    }
  }
  
  // WLED light capability bitmask: 1 = RGB, 2 = white channel, 4 = CCT
  async _getLightCapabilities() {
    if (typeof this._lightCapabilities === 'number') {
      return this._lightCapabilities;
    }
    
    const stored = this.getStoreValue('lightCapabilities');
    if (typeof stored === 'number') {
      this._lightCapabilities = stored;
      return stored;
    }
    
    try {
      return this._storeLightCapabilities(await this._get('/json/info'));
    } catch (error) {
      this.error(`Could not determine light capabilities: ${error.message}`);
      return 1; // Assume a plain RGB strip
    }
  }
  
  // Read the light capability bitmask out of a /json/info payload
  _storeLightCapabilities(info) {
    const leds = info && info.leds ? info.leds : {};
    
    // seglc is per segment and more accurate than the global lc
    let lightCapabilities;
    if (Array.isArray(leds.seglc) && leds.seglc.length > 0) {
      lightCapabilities = leds.seglc[0];
    } else if (typeof leds.lc === 'number') {
      lightCapabilities = leds.lc;
    }
    
    // Older firmware doesn't report lc, and 0 means the segment is inactive
    if (typeof lightCapabilities !== 'number' || lightCapabilities === 0) {
      lightCapabilities = leds.wv ? 3 : 1;
    }
    
    if (this._lightCapabilities !== lightCapabilities) {
      this.log(`WLED light capabilities: ${lightCapabilities} (RGB: ${!!(lightCapabilities & 1)}, white: ${!!(lightCapabilities & 2)}, CCT: ${!!(lightCapabilities & 4)})`);
    }
    
    this._lightCapabilities = lightCapabilities;
    this.setStoreValue('lightCapabilities', lightCapabilities).catch(this.error);
    
    return lightCapabilities;
  }
  
  // Map a Homey light_temperature value (0 = coldest, 1 = warmest) to Kelvin
  _temperatureToKelvin(value) {
    const WARMEST = 2000;
    const COLDEST = 6535;
    
    return Math.round(COLDEST - (value * (COLDEST - WARMEST)));
  }
  
  // Approximate the RGB white point of a color temperature, used on strips that
  // have no CCT channels of their own
  _kelvinToRgb(kelvin) {
    const temp = Math.max(1000, Math.min(40000, kelvin)) / 100;
    let r;
    let g;
    let b;
    
    if (temp <= 66) {
      r = 255;
      g = (99.4708025861 * Math.log(temp)) - 161.1195681661;
      b = temp <= 19 ? 0 : (138.5177312231 * Math.log(temp - 10)) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
      b = 255;
    }
    
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    
    return { r: clamp(r), g: clamp(g), b: clamp(b) };
  }
  
  // Convert RGB to HSV
  _rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, v = max;
    
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    
    if (max === min) {
      h = 0; // achromatic
    } else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    
    return { h, s, v };
  }
  
  // Convert HSV to RGB
  _hsvToRgb(h, s, v) {
    let r, g, b;
    
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    
    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
    };
  }
  
  // This matches the discovery result with the device.
  // Device ids are built from the MAC address (`wled-<mac>`) with an IP based
  // fallback (`wled-<ip-with-dashes>`), so both forms have to be checked - the
  // old check only ever built the IP form and therefore never matched a device
  // that was paired with a MAC based id.
  onDiscoveryResult(discoveryResult) {
    const id = this.getData().id;
    const candidates = [];
    
    const mac = discoveryResult.txt && discoveryResult.txt.mac;
    if (mac) {
      candidates.push(`wled-${String(mac).replace(/:/g, '').toLowerCase()}`);
    }
    
    if (discoveryResult.address) {
      candidates.push(`wled-${discoveryResult.address.replace(/\./g, '-')}`);
    }
    
    if (discoveryResult.id) {
      candidates.push(`wled-${String(discoveryResult.id).replace(/\./g, '-')}`);
    }
    
    return candidates.includes(id);
  }
  
  onDiscoveryAvailable(discoveryResult) {
    this._updateAddressFromDiscovery(discoveryResult).catch(this.error);
  }
  
  onDiscoveryAddressChanged(discoveryResult) {
    this._updateAddressFromDiscovery(discoveryResult).catch(this.error);
  }
  
  // Follow the device when DHCP hands it a new address, instead of leaving it
  // unavailable until someone edits the IP by hand
  async _updateAddressFromDiscovery(discoveryResult) {
    const address = discoveryResult && discoveryResult.address;
    
    if (!address) {
      return;
    }
    
    const settings = this.getSettings();
    if (settings.ip === address && settings.address === address) {
      return;
    }
    
    this.log(`Discovery reported a new address: ${address}`);
    
    await this.setSettings({ ip: address, address: address }).catch(this.error);
    
    // Anything cached belongs to the old connection
    this._segmentIds = null;
    this._presets = null;
    
    await this.updateDeviceState().catch(this.error);
  }
  
  async onDeleted() {
    this.log('Device deleted');
    
    // Clean up resources
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
  
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings updated');
    
    if (changedKeys.includes('ip') || changedKeys.includes('address') || 
        changedKeys.includes('polling_interval') || changedKeys.includes('pollInterval')) {
      this.log('Device connection settings changed, reinitializing');
      
      // Clear existing polling
      if (this.pollTimer) {
        this.homey.clearTimeout(this.pollTimer);
      }
      
      // Update polling interval if changed
      if (changedKeys.includes('polling_interval') || changedKeys.includes('pollInterval')) {
        // Use polling_interval if available, otherwise convert pollInterval from seconds to ms
        this.pollingInterval = newSettings.polling_interval || 
          (newSettings.pollInterval ? newSettings.pollInterval * 1000 : 5000);
        
        // scheduleNextPoll works off basePollingInterval, so without this the
        // new interval was stored but never actually used
        this.basePollingInterval = this.pollingInterval;
        this.log(`Polling interval updated to ${this.pollingInterval}ms`);
      }
      
      // Drop anything cached for the old connection if the IP changed
      if (changedKeys.includes('ip') || changedKeys.includes('address')) {
        this.log(`IP address updated to ${newSettings.ip || newSettings.address}`);
        this._segmentIds = null;
        this._presets = null;
        this._lightCapabilities = undefined;
      }
      
      // Restart polling with new settings
      this.scheduleNextPoll();
      
      // Refresh device state immediately
      await this.updateDeviceState();
      
      // Refresh effects and palettes
      await this.fetchEffectsAndPalettes();
    }
  }
}

module.exports = WLEDDevice; 