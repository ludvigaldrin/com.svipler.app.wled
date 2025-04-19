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
      this.maxPresetId = settings.presetcount ? parseInt(settings.presetcount) - 1 : 255;
      // Initialize capability values with defaults
      if (this.hasCapability('wled_effect') && !this.getCapabilityValue('wled_effect')) {
        await this.setCapabilityValue('wled_effect', "0").catch(this.error);
      }
      
      if (this.hasCapability('wled_palette') && !this.getCapabilityValue('wled_palette')) {
        await this.setCapabilityValue('wled_palette', "0").catch(this.error);
      }

      if (this.hasCapability('wled_preset') && !this.getCapabilityValue('wled_preset')) {
        await this.setCapabilityValue('wled_preset', "0").catch(this.error);
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
        const settings = this.getSettings();
        const ipAddress = settings.ip || settings.address;
        
        if (!ipAddress) {
          throw new Error('No IP address configured');
        }
        
        // Create fresh client for this request
        const apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 5000,
        });
        
        // Set on/off state
        await apiClient.post('/json/state', { on: value });
        
        return true;
      } catch (error) {
        this.error(`Error setting on/off: ${error.message}`);
        throw error;
      }
    });
    
    // Dimmer capability
    this.registerCapabilityListener('dim', async (value) => {
      try {
        const settings = this.getSettings();
        const ipAddress = settings.ip || settings.address;
        
        if (!ipAddress) {
          throw new Error('No IP address configured');
        }
        
        // Create fresh client for this request
        const apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 5000,
        });
        
        // Convert 0-1 to 0-255 brightness
        const brightness = Math.round(value * 255);
        
        // Set brightness
        await apiClient.post('/json/state', { bri: brightness });
        
        return true;
      } catch (error) {
        this.error(`Error setting brightness: ${error.message}`);
        throw error;
      }
    });
    
    // Color capabilities
    this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], async (valueObj) => {
      try {
        const settings = this.getSettings();
        const ipAddress = settings.ip || settings.address;
        
        if (!ipAddress) {
          throw new Error('No IP address configured');
        }
        
        // Create fresh client for this request
        const apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 5000,
        });
        
        // Get current values if not changed
        const hue = valueObj.light_hue !== undefined ? valueObj.light_hue : await this.getCapabilityValue('light_hue');
        const saturation = valueObj.light_saturation !== undefined ? valueObj.light_saturation : await this.getCapabilityValue('light_saturation');
        
        // Convert HSV to RGB
        const rgb = this._hsvToRgb(hue, saturation, 1);
        
        // Set color for first segment
        await apiClient.post('/json/state', {
          seg: [
            {
              col: [
                [rgb.r, rgb.g, rgb.b]
              ]
            }
          ]
        });
        
        return true;
      } catch (error) {
        this.error(`Error setting color: ${error.message}`);
        throw error;
      }
    }, 500);
    
    // Effect capability
    this.registerCapabilityListener('wled_effect', async (value) => {
      try {
        const settings = this.getSettings();
        const ipAddress = settings.ip || settings.address;
        
        if (!ipAddress) {
          this.error('No IP address configured for effect setting');
          return false;
        }
        
        // Create fresh client for this request
        const apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 5000,
        });
        
        // Convert string ID to number
        const effectId = parseInt(value, 10);
        
        // Check if effect ID is valid
        if (isNaN(effectId) || effectId < 0 || effectId > this.maxEffectId) {
          this.error(`Invalid effect ID: ${value}`);
          return false;
        }
        
        // Set effect for first segment - use effectId directly as WLED uses 0-based indexing
        await apiClient.post('/json/state', {
          seg: [
            {
              fx: effectId
            }
          ]
        });
        
        return true;
      } catch (error) {
        this.error(`Error setting effect: ${error.message}`);
        return false;
      }
    });
    
    // Palette capability
    this.registerCapabilityListener('wled_palette', async (value) => {
      try {
        const settings = this.getSettings();
        const ipAddress = settings.ip || settings.address;
        
        if (!ipAddress) {
          this.error('No IP address configured for palette setting');
          return false;
        }
        
        // Create fresh client for this request
        const apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 5000,
        });
        
        // Convert string ID to number
        const paletteId = parseInt(value, 10);
        
        // Check if palette ID is valid
        if (isNaN(paletteId) || paletteId < 0 || paletteId > this.maxPaletteId) {
          this.error(`Invalid palette ID: ${value}`);
          return false;
        }
        
        // Set palette for first segment - use paletteId directly as WLED uses 0-based indexing
        await apiClient.post('/json/state', {
          seg: [
            {
              pal: paletteId
            }
          ]
        });
        
        return true;
      } catch (error) {
        this.error(`Error setting palette: ${error.message}`);
        return false;
      }
    });

    // Preset capability
    this.registerCapabilityListener('wled_preset', async (value) => {
      try {
        const settings = this.getSettings();
        const ipAddress = settings.ip || settings.address;
        
        if (!ipAddress) {
          this.error('No IP address configured for preset setting');
          return false;
        }
        
        // Create fresh client for this request
        const apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 5000,
        });
        
        // Convert string ID to number
        const presetId = parseInt(value, 10);
        
        // Send the preset ID directly to WLED
        // WLED uses -1 for no preset and positive numbers for actual presets
        await apiClient.post('/json/state', { ps: presetId });
        
        return true;
      } catch (error) {
        this.error(`Error setting preset: ${error.message}`);
        return false;
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
  
  // Set a preset by ID - called from flow card action
  async setPreset(presetId) {
    try {
      // Validate the preset ID
      if (presetId === undefined || presetId === null) {
        throw new Error('No preset ID provided');
      }
      
      // Set the capability value - this will trigger the capability listener
      await this.setCapabilityValue('wled_preset', String(presetId));
      return true;
    } catch (error) {
      this.error(`Error setting preset: ${error.message}`);
      throw error;
    }
  }
  
  // Set an effect by ID - called from flow card action
  async setEffect(effectId) {
    try {
      // Validate the effect ID
      if (effectId === undefined || effectId === null) {
        throw new Error('No effect ID provided');
      }
      
      // Set the capability value - this will trigger the capability listener
      await this.setCapabilityValue('wled_effect', String(effectId));
      return true;
    } catch (error) {
      this.error(`Error setting effect: ${error.message}`);
      throw error;
    }
  }
  
  // Set a palette by ID - called from flow card action
  async setPalette(paletteId) {
    try {
      // Validate the palette ID
      if (paletteId === undefined || paletteId === null) {
        throw new Error('No palette ID provided');
      }
      
      // Set the capability value - this will trigger the capability listener
      await this.setCapabilityValue('wled_palette', String(paletteId));
      return true;
    } catch (error) {
      this.error(`Error setting palette: ${error.message}`);
      throw error;
    }
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
      
      // Create options from default presets
      return this._getDefaultPresets().map((name, id) => ({
        id: String(id),
        name: name
      }));
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
      
      // Create a fresh API client for this request
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      // Get state from WLED API
      const response = await apiClient.get('/json/state');
      
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
      
      // Update device capabilities
      await this.setCapabilityValue('onoff', !!state.on).catch(this.error);
      
      if (state.bri !== undefined) {
        await this.setCapabilityValue('dim', state.bri / 255).catch(this.error);
      }
      
      if (state.seg && state.seg[0]) {
        const segment = state.seg[0];
        
        // Color values
        if (segment.col && segment.col[0]) {
          const rgb = segment.col[0];
          const hsv = this._rgbToHsv(rgb[0], rgb[1], rgb[2]);
          
          await this.setCapabilityValue('light_hue', hsv.h).catch(this.error);
          await this.setCapabilityValue('light_saturation', hsv.s).catch(this.error);
        }
        
        // Effect - use WLED's effect ID directly (0-based)
        if (segment.fx !== undefined) {
          if (segment.fx < 0 || segment.fx > this.maxEffectId) {
            this.log(`Effect ID ${segment.fx} out of range (max: ${this.maxEffectId})`);
          } else {
            await this.setCapabilityValue('wled_effect', String(segment.fx)).catch(this.error);
          }
        }
        
        // Palette - use WLED's palette ID directly (0-based)
        if (segment.pal !== undefined) {
          if (segment.pal < 0 || segment.pal > this.maxPaletteId) {
            this.log(`Palette ID ${segment.pal} out of range (max: ${this.maxPaletteId})`);
          } else {
            await this.setCapabilityValue('wled_palette', String(segment.pal)).catch(this.error);
          }
        }
      }
      
      // Preset - handle the preset ID correctly
      if (state.ps !== undefined) {
        try {
          const presetId = String(state.ps);
          
          // Check if we have this preset in our capability options
          const presetOptions = await this.getCapabilityOptions('wled_preset');
          
          // Ensure we have the preset ID in our options
          if (presetOptions && presetOptions.values) {
            const hasPresetId = presetOptions.values.some(option => option.id === presetId);
            
            if (!hasPresetId && parseInt(presetId) > 0) {
              // We need to add this preset ID to our options
              await this.fetchEffectsAndPalettes();
            } else {
              // It's a known preset ID, just set it
              await this.setCapabilityValue('wled_preset', presetId).catch(error => {
                this.error(`Error setting preset value: ${error.message}`);
              });
            }
          } else {
            // No options yet, force a fetch
            await this.fetchEffectsAndPalettes();
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
      
      // Create a fresh API client for this request
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      // First get effects and palettes
      const response = await apiClient.get('/json');
      const data = response.data;
      
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
      try {
        const presetsResponse = await apiClient.get('/presets.json');
        const presets = presetsResponse.data;
        
        if (presets) {
          // Filter out non-preset entries and convert to array format
          const presetArray = Object.entries(presets)
            .filter(([id, preset]) => {
              // Filter out metadata entries and ensure preset has required data
              return preset && 
                     preset.n && // Has a name
                     !id.startsWith('_') && // Not a metadata entry
                     parseInt(id) > 0; // Valid preset ID (greater than 0)
            })
            .map(([id, preset]) => ({
              id: String(id),
              name: preset.n
            }));
          
          // Update the maximum preset ID based on actual presets
          this.maxPresetId = Math.max(...presetArray.map(p => parseInt(p.id, 10)), 0);
          
          // Update device capability options
          await this._updatePresetsCapability(presetArray);
        } else {
          await this._updatePresetsCapability([]);
        }
      } catch (presetError) {
        this.error('Error fetching presets:', presetError);
        await this._updatePresetsCapability([]);
      }
      
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
      
      // Update effect and palette counts if they're different
      if (data.fxcount && settings.fxcount !== data.fxcount) {
        updatedSettings.fxcount = data.fxcount;
        settingsChanged = true;
      }
      
      if (data.palcount && settings.palcount !== data.palcount) {
        updatedSettings.palcount = data.palcount;
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
      
      // Only log count during initial setup
      if (!this.effectsAndPalettesFetched) {
       // this.log(`Found ${effectOptions.length} effects`);
      }
      
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
      
      // Only log count during initial setup
      if (!this.effectsAndPalettesFetched) {
       // this.log(`Found ${paletteOptions.length} palettes`);
      }
      
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
      // Ensure we always have the "No Preset" option
      const defaultPreset = {
        id: "-1", // WLED uses -1 for no preset
        name: "No Preset"
      };

      // Convert to format expected by capability options
      let presetOptions = [defaultPreset];
      
      // Add all the actual presets from the device
      presets.forEach(preset => {
        presetOptions.push({
          id: preset.id,
          name: preset.name || `Preset ${preset.id}`
        });
      });
      
      // Make sure we have at least the first 10 preset IDs for default
      for (let i = 1; i <= 10; i++) {
        const idStr = String(i);
        if (!presetOptions.some(p => p.id === idStr)) {
          presetOptions.push({
            id: idStr,
            name: `Preset ${i}`
          });
        }
      }
      
      // Convert to capability options format
      presetOptions = presetOptions.map(preset => ({
        id: preset.id,
        title: {
          en: preset.name
        }
      }));
      
      // Sort presets by ID numerically, keeping "No Preset" at the top
      presetOptions.sort((a, b) => {
        // Keep "No Preset" at the top
        if (a.id === "-1") return -1;
        if (b.id === "-1") return 1;
        // Sort others by ID numerically
        return parseInt(a.id) - parseInt(b.id);
      });
      
      // Update the capability options
      await this.setCapabilityOptions('wled_preset', {
        values: presetOptions
      }).catch(err => this.error(`Failed to set preset options: ${err.message}`));
      
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
  
  // Default presets to use if API doesn't provide them
  _getDefaultPresets() {
    return [
      'No Preset',
      'Preset 1',
      'Preset 2',
      'Preset 3',
      'Preset 4',
      'Preset 5'
    ];
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
  
  // This matches the discovery result with the device
  onDiscoveryResult(discoveryResult) {
    // Return true if this is your device
    const id = this.getData().id;
    return id === `wled-${discoveryResult.id.replace(/\./g, '-')}`;
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
        this.log(`Polling interval updated to ${this.pollingInterval}ms`);
      }
      
      // Update API client if IP changed
      if (changedKeys.includes('ip') || changedKeys.includes('address')) {
        // Use ip if available, otherwise use address
        const ipAddress = newSettings.ip || newSettings.address;
        this.log(`IP address updated to ${ipAddress}`);
        this.apiClient = axios.create({
          baseURL: `http://${ipAddress}`,
          timeout: 10000
        });
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