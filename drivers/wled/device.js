'use strict';

const Homey = require('homey');
const axios = require('axios');

class WLEDDevice extends Homey.Device {
  
  async onInit() {
    try {
      this.log('WLED device initializing');
      
      // Get device settings
      const settings = this.getSettings();
      this.log('Device settings:', settings);
      
      // Check for IP address (support both 'ip' and 'address' for backwards compatibility)
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        this.error('No IP address set for WLED device');
        throw new Error('No IP address set for WLED device');
      }
      
      // Set default values for effect/palette ranges
      this.maxEffectId = settings.fxcount ? parseInt(settings.fxcount) - 1 : 255;
      this.maxPaletteId = settings.palcount ? parseInt(settings.palcount) - 1 : 255;
      this.log(`Initial max effect ID: ${this.maxEffectId}, max palette ID: ${this.maxPaletteId}`);
      
      // Initialize capability values with defaults
      if (this.hasCapability('wled_effect') && !this.getCapabilityValue('wled_effect')) {
        await this.setCapabilityValue('wled_effect', "0").catch(this.error);
      }
      
      if (this.hasCapability('wled_palette') && !this.getCapabilityValue('wled_palette')) {
        await this.setCapabilityValue('wled_palette', "0").catch(this.error);
      }
      
      // Set up polling intervals
      this.lastStateUpdate = 0;
      this.pollingInterval = settings.polling_interval || 
        (settings.pollInterval ? settings.pollInterval * 1000 : 5000);
      
      // Make sure API client is properly configured on each operation
      // Start with immediate state update with a shorter timeout
      setTimeout(() => this.updateDeviceState(), 1000);
      
      // Set up regular polling
      this.pollTimer = this.homey.setInterval(() => this.updateDeviceState(), this.pollingInterval);
      
      // Register capability listeners
      this.registerCapabilityListener('onoff', this.onOffCapabilityListener.bind(this));
      this.registerCapabilityListener('dim', this.dimCapabilityListener.bind(this));
      this.registerMultipleCapabilityListener(['light_hue', 'light_saturation'], this.colorCapabilityListener.bind(this));
      this.registerCapabilityListener('wled_effect', this.effectCapabilityListener.bind(this));
      this.registerCapabilityListener('wled_palette', this.paletteCapabilityListener.bind(this));
      
      // Initialize effects and palettes for selection after a short delay
      setTimeout(() => {
        this.fetchEffectsAndPalettes().catch(error => {
          this.error('Error initializing effects and palettes:', error);
        });
      }, 2000);
      
      this.log('WLED device initialization completed');
    } catch (error) {
      this.error(`Device initialization failed: ${error.message || error}`);
    }
  }
  
  // Effect capability listener
  async effectCapabilityListener(value) {
    try {
      this.log(`Setting effect: ${value}`);
      
      // Ensure API client is available
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        throw new Error('No IP address available');
      }
      
      // Recreate client to ensure fresh connection
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      const effectId = parseInt(value);
      if (isNaN(effectId) || effectId < 0 || effectId > this.maxEffectId) {
        throw new Error(`Invalid effect ID: ${value}`);
      }
      
      await apiClient.post('/json/state', {
        seg: [{
          fx: effectId
        }]
      });
      
      this.log(`Effect ${value} set successfully`);
      return true;
    } catch (error) {
      this.error(`Error setting effect: ${error.message || error}`);
      throw error;
    }
  }
  
  // Palette capability listener
  async paletteCapabilityListener(value) {
    try {
      this.log(`Setting palette: ${value}`);
      
      // Ensure API client is available
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        throw new Error('No IP address available');
      }
      
      // Recreate client to ensure fresh connection
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      const paletteId = parseInt(value);
      if (isNaN(paletteId) || paletteId < 0 || paletteId > this.maxPaletteId) {
        throw new Error(`Invalid palette ID: ${value}`);
      }
      
      await apiClient.post('/json/state', {
        seg: [{
          pal: paletteId
        }]
      });
      
      this.log(`Palette ${value} set successfully`);
      return true;
    } catch (error) {
      this.error(`Error setting palette: ${error.message || error}`);
      throw error;
    }
  }
  
  // On/off capability listener
  async onOffCapabilityListener(value) {
    try {
      this.log(`Setting onoff: ${value}`);
      
      // Ensure API client is available
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        throw new Error('No IP address available');
      }
      
      // Recreate client to ensure fresh connection
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      await apiClient.post('/json/state', { on: value });
      
      this.log(`On/off set to ${value} successfully`);
      return true;
    } catch (error) {
      this.error(`Error setting on/off: ${error.message || error}`);
      throw error;
    }
  }
  
  // Dimmer capability listener
  async dimCapabilityListener(value) {
    try {
      this.log(`Setting dim: ${value}`);
      
      // Ensure API client is available
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        throw new Error('No IP address available');
      }
      
      // Recreate client to ensure fresh connection
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      const brightness = Math.round(value * 255);
      await apiClient.post('/json/state', { bri: brightness });
      
      this.log(`Brightness set to ${brightness} successfully`);
      return true;
    } catch (error) {
      this.error(`Error setting brightness: ${error.message || error}`);
      throw error;
    }
  }
  
  // Color capability listener
  async colorCapabilityListener(values, opts) {
    try {
      // Handle both hue and saturation in one method
      let hue = this.getCapabilityValue('light_hue');
      let saturation = this.getCapabilityValue('light_saturation');
      
      // Update with the values that changed
      if (values.light_hue !== undefined) {
        hue = values.light_hue;
      }
      if (values.light_saturation !== undefined) {
        saturation = values.light_saturation;
      }
      
      this.log(`Setting color - hue: ${hue}, saturation: ${saturation}`);
      
      // Ensure API client is available
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      if (!ipAddress) {
        throw new Error('No IP address available');
      }
      
      // Recreate client to ensure fresh connection
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      // Convert HSV to RGB
      const rgb = this._hsvToRgb(hue, saturation, 1);
      
      // Update the segment color
      await apiClient.post('/json/state', {
        seg: [{ col: [[rgb.r, rgb.g, rgb.b]] }]
      });
      
      this.log(`Color set successfully to RGB(${rgb.r}, ${rgb.g}, ${rgb.b})`);
      return true;
    } catch (error) {
      this.error(`Error setting color: ${error.message || error}`);
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
        return updatedOptions.values;
      }
      
      // Filter by query if provided
      if (query && query.length > 0) {
        const lcQuery = query.toLowerCase();
        return effectOptions.values.filter(option => 
          option.name.toLowerCase().includes(lcQuery)
        );
      }
      
      return effectOptions.values;
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
        return updatedOptions.values;
      }
      
      // Filter by query if provided
      if (query && query.length > 0) {
        const lcQuery = query.toLowerCase();
        return paletteOptions.values.filter(option => 
          option.name.toLowerCase().includes(lcQuery)
        );
      }
      
      return paletteOptions.values;
    } catch (error) {
      this.error('Error getting palettes list:', error);
      
      // Create options from default palettes
      return this._getDefaultPalettes().map((name, id) => ({
        id: String(id),
        name: name
      }));
    }
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
      this.log(`Polling device state from ${ipAddress}`);
      const response = await apiClient.get('/json/state');
      
      if (!response || !response.data) {
        this.error('Invalid response from WLED API');
        await this.setUnavailable('Invalid response from device');
        return;
      }
      
      // If we get here, the device is available
      this.setAvailable();
      
      const state = response.data;
      this.log(`Received state: on=${state.on}, brightness=${state.bri || 'unknown'}`);
      
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
        
        // Effect
        if (segment.fx !== undefined) {
          const effectId = String(segment.fx);
          this.log(`Current effect ID: ${effectId}`);
          
          if (segment.fx < 0 || segment.fx > this.maxEffectId) {
            this.log(`Effect ID ${effectId} out of range (max: ${this.maxEffectId}), setting to 0`);
            await this.setCapabilityValue('wled_effect', "0").catch(this.error);
          } else {
            // Try to get the effect name for display
            try {
              // Get current effects options
              const effectOptions = await this.getCapabilityOptions('wled_effect');
              const effectName = effectOptions?.values?.find(e => e.id === effectId)?.title?.en || `Effect ${effectId}`;
              this.log(`Current effect: ID=${effectId}, Name=${effectName}`);
            } catch (error) {
              this.error(`Error getting effect name: ${error.message}`);
            }
            
            await this.setCapabilityValue('wled_effect', effectId).catch(this.error);
          }
        }
        
        // Palette
        if (segment.pal !== undefined) {
          const paletteId = String(segment.pal);
          this.log(`Current palette ID: ${paletteId}`);
          
          if (segment.pal < 0 || segment.pal > this.maxPaletteId) {
            this.log(`Palette ID ${paletteId} out of range (max: ${this.maxPaletteId}), setting to 0`);
            await this.setCapabilityValue('wled_palette', "0").catch(this.error);
          } else {
            // Try to get the palette name for display
            try {
              // Get current palette options
              const paletteOptions = await this.getCapabilityOptions('wled_palette');
              const paletteName = paletteOptions?.values?.find(p => p.id === paletteId)?.title?.en || `Palette ${paletteId}`;
              this.log(`Current palette: ID=${paletteId}, Name=${paletteName}`);
            } catch (error) {
              this.error(`Error getting palette name: ${error.message}`);
            }
            
            await this.setCapabilityValue('wled_palette', paletteId).catch(this.error);
          }
        }
      }
      
      // Update last state time
      this.lastStateUpdate = Date.now();
      
      // Log successful update
      this.log('Device state updated successfully');
      
      // If we haven't fetched effects and palettes yet, do it now
      if (!this.effectsAndPalettesFetched) {
        this.fetchEffectsAndPalettes()
          .then(() => {
            this.effectsAndPalettesFetched = true;
          })
          .catch(error => {
            this.error('Failed to fetch effects and palettes:', error.message);
          });
      }
    } catch (error) {
      // Set device as unavailable if we get a connection error
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || 
          error.code === 'ECONNABORTED' || error.code === 'ECONNRESET') {
        this.error(`Connection error: ${error.message}`);
        await this.setUnavailable('Cannot connect to device');
      } else {
        this.error(`Error fetching device state: ${error.message || error}`);
      }
    }
  }
  
  // Helper methods for effects and palettes
  async fetchEffectsAndPalettes() {
    try {
      this.log('Fetching effects and palettes from device');
      
      // Get IP address from settings
      const settings = this.getSettings();
      const ipAddress = settings.ip || settings.address;
      
      if (!ipAddress) {
        this.error('No IP address in settings, cannot fetch effects and palettes');
        throw new Error('No IP address configured');
      }
      
      // Create a fresh API client for this request
      const apiClient = axios.create({
        baseURL: `http://${ipAddress}`,
        timeout: 5000,
      });
      
      // Try to get effects and palettes from main API endpoint
      const response = await apiClient.get('/json');
      const data = response.data;
      
      // Handle effects
      if (data && data.effects && Array.isArray(data.effects)) {
        // Update the maximum effect ID
        this.maxEffectId = data.effects.length - 1;
        this.log(`Found ${data.effects.length} effects, max ID: ${this.maxEffectId}`);
        
        // Update device capability options
        await this._updateEffectsCapability(data.effects);
      } else {
        this.log('Effects not found in main API response, using defaults');
        await this._updateEffectsCapability(this._getDefaultEffects());
      }
      
      // Handle palettes
      if (data && data.palettes && Array.isArray(data.palettes)) {
        // Update the maximum palette ID
        this.maxPaletteId = data.palettes.length - 1;
        this.log(`Found ${data.palettes.length} palettes, max ID: ${this.maxPaletteId}`);
        
        // Update device capability options
        await this._updatePalettesCapability(data.palettes);
      } else {
        this.log('Palettes not found in main API response, using defaults');
        await this._updatePalettesCapability(this._getDefaultPalettes());
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
        this.log('Updating device settings with info from API');
        await this.setSettings(updatedSettings);
      }
      
      this.log('Effects and palettes updated successfully');
      return true;
    } catch (error) {
      this.error(`Error fetching effects and palettes: ${error.message || error}`);
      
      // Fall back to defaults if there's an error
      this.log('Using default effects and palettes');
      await this._updateEffectsCapability(this._getDefaultEffects());
      await this._updatePalettesCapability(this._getDefaultPalettes());
      return false;
    }
  }
  
  async _updateEffectsCapability(effects) {
    try {
      // Convert to format expected by capability options - note: uses 'title' not 'name'
      const effectOptions = effects.map((name, id) => ({
        id: String(id),
        title: {
          en: name || `Effect ${id}`
        }
      }));
      
      this.log(`Updating effects capability with ${effectOptions.length} options`);
      
      // Log a few sample effects to debug
      if (effectOptions.length > 0) {
        this.log(`Sample effects: ${JSON.stringify(effectOptions.slice(0, 3))}`);
      }
      
      // Update the capability options
      await this.setCapabilityOptions('wled_effect', {
        values: effectOptions
      });
      
      this.log(`Updated effects capability with ${effectOptions.length} options`);
    } catch (error) {
      this.error('Error updating effects capability:', error);
    }
  }
  
  async _updatePalettesCapability(palettes) {
    try {
      // Convert to format expected by capability options - note: uses 'title' not 'name'
      const paletteOptions = palettes.map((name, id) => ({
        id: String(id),
        title: {
          en: name || `Palette ${id}`
        }
      }));
      
      this.log(`Updating palettes capability with ${paletteOptions.length} options`);
      
      // Log a few sample palettes to debug
      if (paletteOptions.length > 0) {
        this.log(`Sample palettes: ${JSON.stringify(paletteOptions.slice(0, 3))}`);
      }
      
      // Update the capability options
      await this.setCapabilityOptions('wled_palette', {
        values: paletteOptions
      });
      
      this.log(`Updated palettes capability with ${paletteOptions.length} options`);
    } catch (error) {
      this.error('Error updating palettes capability:', error);
    }
  }
  
  // Default effects to use if API doesn't provide them
  _getDefaultEffects() {
    return [
      'Solid',
      'Blink',
      'Breathe',
      'Wipe',
      'Fade',
      'Colorloop',
      'Rainbow',
      'Scan',
      'Dual Scan',
      'Fade Out',
      'Chase',
      'Chase Rainbow',
      'Running'
    ];
  }
  
  // Default palettes to use if API doesn't provide them
  _getDefaultPalettes() {
    return [
      'Default',
      'Random Colors',
      'Primary Color',
      'Based on Primary',
      'Set Colors',
      'Rainbow',
      'Rainbow with Glitter',
      'Cloud',
      'Lava',
      'Ocean',
      'Forest',
      'Party'
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
      this.homey.clearInterval(this.pollTimer);
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
        this.homey.clearInterval(this.pollTimer);
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
      this.pollTimer = this.homey.setInterval(() => this.updateDeviceState(), this.pollingInterval);
      
      // Refresh device state immediately
      await this.updateDeviceState();
      
      // Refresh effects and palettes
      await this.fetchEffectsAndPalettes();
    }
  }
}

module.exports = WLEDDevice; 