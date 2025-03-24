'use strict';

const Homey = require('homey');
const { HttpClient } = require('../../lib/http-client');

class WLEDDevice extends Homey.Device {
  
  async onInit() {
    this.log('WLED device initialized');
    
    const settings = this.getSettings();
    const { address } = settings;
    
    // Make sure we have an address
    if (!address) {
      this.error('No IP address in settings');
      throw new Error('No IP address in settings');
    }
    
    // Create HTTP client
    this.apiClient = new HttpClient({
      baseURL: `http://${address}`,
      timeout: 10000 // Increase timeout to 10 seconds
    });
    
    // Initialize capabilities with default values if not set
    if (this.hasCapability('wled_effect')) {
      if (this.getCapabilityValue('wled_effect') === null) {
        await this.setCapabilityValue('wled_effect', '0').catch(this.error);
      }
    }
    
    if (this.hasCapability('wled_palette')) {
      if (this.getCapabilityValue('wled_palette') === null) {
        await this.setCapabilityValue('wled_palette', '0').catch(this.error);
      }
    }
    
    // Set up polling for device state
    this.pollInterval = settings.pollInterval * 1000 || 5000;
    this.lastStateUpdate = 0;
    this.failedPollCount = 0; // Track failed poll attempts
    
    // Start polling with a slight delay
    this.pollTimer = this.homey.setTimeout(() => {
      this.pollDevice();
    }, 1000);
    
    // Register capability listeners
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerCapabilityListener('light_hue', this.onCapabilityColor.bind(this));
    this.registerCapabilityListener('light_saturation', this.onCapabilityColor.bind(this));
    this.registerCapabilityListener('wled_effect', this.onCapabilityEffect.bind(this));
    this.registerCapabilityListener('wled_palette', this.onCapabilityPalette.bind(this));
    
    // Initialize effects and palettes for selection
    try {
      await this.updateEffectsList();
      await this.updatePalettesList();
    } catch (error) {
      this.error('Error initializing effects and palettes:', error);
    }
  }
  
  // Fix the startPolling method - it's missing the function keyword
  startPolling = () => {
    // Clear any existing timer
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    
    // Start a new polling timer
    this.pollTimer = this.homey.setTimeout(() => {
      this.pollDevice();
    }, this.pollInterval);
  }
  
  // Poll the device for its current state
  async pollDevice() {
    try {
      // Only poll if enough time has passed since last state update
      const now = Date.now();
      if (now - this.lastStateUpdate > this.pollInterval / 2) {
        await this.updateDeviceState();
        // Reset failed counter on success
        this.failedPollCount = 0;
      }
    } catch (error) {
      this.error('Error polling device:', error);
      // Increment failed counter
      this.failedPollCount++;
      
      // If we've failed multiple times, increase the interval temporarily
      if (this.failedPollCount > 3) {
        this.log('Multiple polling failures, increasing interval temporarily');
        this.pollInterval = Math.min(30000, this.pollInterval * 2);
      }
    } finally {
      // Always restart polling
      this.startPolling();
    }
  }
  
  async updateDeviceState() {
    try {
      const state = await this.apiClient.get('/json/state');
      
      // Update device capabilities
      await this.setCapabilityValue('onoff', !!state.on);
      
      if (state.bri !== undefined) {
        await this.setCapabilityValue('dim', state.bri / 255);
      }
      
      if (state.seg && state.seg[0]) {
        const segment = state.seg[0];
        
        // Color values
        if (segment.col && segment.col[0]) {
          const rgb = segment.col[0];
          const hsv = this._rgbToHsv(rgb[0], rgb[1], rgb[2]);
          
          await this.setCapabilityValue('light_hue', hsv.h);
          await this.setCapabilityValue('light_saturation', hsv.s);
        }
        
        // Effect - MUST be a string for enum capabilities
        if (segment.fx !== undefined) {
          const effectId = String(segment.fx);
          // Always set to 0 if out of range
          if (segment.fx < 0 || segment.fx > 5) {
            this.log(`Effect ID ${effectId} out of range, setting to 0`);
            await this.setCapabilityValue('wled_effect', "0");
          } else {
            await this.setCapabilityValue('wled_effect', effectId);
          }
        }
        
        // Palette - MUST be a string for enum capabilities
        if (segment.pal !== undefined) {
          const paletteId = String(segment.pal);
          // Always set to 0 if out of range
          if (segment.pal < 0 || segment.pal > 5) {
            this.log(`Palette ID ${paletteId} out of range, setting to 0`);
            await this.setCapabilityValue('wled_palette', "0");
          } else {
            await this.setCapabilityValue('wled_palette', paletteId);
          }
        }
      }
      
      // Update last state time
      this.lastStateUpdate = Date.now();
    } catch (error) {
      this.error('Error fetching device state:', error);
    }
  }
  
  // Capability handlers
  async onCapabilityOnoff(value) {
    this.log(`Setting onoff: ${value}`);
    await this.apiClient.post('/json/state', { on: value });
    return true;
  }
  
  async onCapabilityDim(value) {
    this.log(`Setting dim: ${value}`);
    const brightness = Math.round(value * 255);
    await this.apiClient.post('/json/state', { bri: brightness });
    return true;
  }
  
  async onCapabilityColor(value, opts) {
    // Handle both hue and saturation in one method
    let hue = this.getCapabilityValue('light_hue');
    let saturation = this.getCapabilityValue('light_saturation');
    
    // Update the value that was changed
    if (opts.capabilityId === 'light_hue') {
      hue = value;
    } else if (opts.capabilityId === 'light_saturation') {
      saturation = value;
    }
    
    this.log(`Setting color - hue: ${hue}, saturation: ${saturation}`);
    
    // Convert HSV to RGB
    const rgb = this._hsvToRgb(hue, saturation, 1);
    
    // Update the segment color
    await this.apiClient.post('/json/state', {
      seg: [{ col: [[rgb.r, rgb.g, rgb.b]] }]
    });
    
    return true;
  }
  
  async onCapabilityEffect(value) {
    try {
      // Convert from string to number for WLED API
      const effectId = parseInt(value);
      
      this.log(`Setting effect to: ${value} (${effectId})`);
      
      // Send to WLED API
      await this.apiClient.post('/json/state', { 
        seg: [{ fx: effectId }] 
      });
      
      return true;
    } catch (error) {
      this.error('Failed to set effect:', error);
      return false;
    }
  }
  
  async onCapabilityPalette(value) {
    try {
      // Convert from string to number for WLED API
      const paletteId = parseInt(value);
      
      this.log(`Setting palette to: ${value} (${paletteId})`);
      
      // Send to WLED API
      await this.apiClient.post('/json/state', { 
        seg: [{ pal: paletteId }] 
      });
      
      return true;
    } catch (error) {
      this.error('Failed to set palette:', error);
      return false;
    }
  }
  
  // Helper methods for effects and palettes
  async updateEffectsList() {
    try {
      const info = await this.apiClient.get('/json/info');
      if (info && Array.isArray(info.effects)) {
        // Store effects for future use
        this.effects = info.effects.map((name, index) => {
          return {
            id: String(index),
            name: name
          };
        });
      } else {
        this.effects = this._getDefaultEffects();
      }
    } catch (error) {
      this.error('Failed to fetch effects list:', error);
      this.effects = this._getDefaultEffects();
    }
  }
  
  async updatePalettesList() {
    try {
      const info = await this.apiClient.get('/json/info');
      if (info && Array.isArray(info.palettes)) {
        // Store palettes for future use
        this.palettes = info.palettes.map((name, index) => {
          return {
            id: String(index),
            name: name
          };
        });
      } else {
        this.palettes = this._getDefaultPalettes();
      }
    } catch (error) {
      this.error('Failed to fetch palettes list:', error);
      this.palettes = this._getDefaultPalettes();
    }
  }
  
  // Method to get available effects for flow cards and UI
  async getEffectsList(query = '') {
    if (!this.effects) {
      await this.updateEffectsList();
    }
    
    // Filter by query if provided
    if (query && query.length > 0) {
      const lcQuery = query.toLowerCase();
      return this.effects.filter(effect => effect.name.toLowerCase().includes(lcQuery));
    }
    
    return this.effects;
  }
  
  // Method to get available palettes for flow cards and UI
  async getPalettesList(query = '') {
    if (!this.palettes) {
      await this.updatePalettesList();
    }
    
    // Filter by query if provided
    if (query && query.length > 0) {
      const lcQuery = query.toLowerCase();
      return this.palettes.filter(palette => palette.name.toLowerCase().includes(lcQuery));
    }
    
    return this.palettes;
  }
  
  // Helper method to set effect from flow card
  async setEffect(effectId) {
    return this.onCapabilityEffect(effectId);
  }
  
  // Helper method to set palette from flow card
  async setPalette(paletteId) {
    return this.onCapabilityPalette(paletteId);
  }
  
  // Default effects to use if API doesn't provide them
  _getDefaultEffects() {
    return [
      { id: '0', name: 'Solid' },
      { id: '1', name: 'Blink' },
      { id: '2', name: 'Breathe' },
      { id: '3', name: 'Wipe' },
      { id: '4', name: 'Fade' },
      { id: '5', name: 'Colorloop' },
      { id: '6', name: 'Rainbow' }
    ];
  }
  
  // Default palettes to use if API doesn't provide them
  _getDefaultPalettes() {
    return [
      { id: '0', name: 'Default' },
      { id: '1', name: 'Random Colors' },
      { id: '2', name: 'Primary Color' },
      { id: '3', name: 'Based on Primary' },
      { id: '4', name: 'Set Colors' },
      { id: '5', name: 'Rainbow' },
      { id: '6', name: 'Rainbow Bands' }
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
  
  // Device cleanup on unload
  async onUninit() {
    // Clear the polling timer
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    
    this.log('WLED Device uninitialized');
  }
  
  onSettings({ oldSettings, newSettings, changedKeys }) {
    // Handle settings changes
    if (changedKeys.includes('address')) {
      this.log(`Address changed to ${newSettings.address}`);
      
      // Update API client
      this.apiClient = new HttpClient({
        baseURL: `http://${newSettings.address}`,
        timeout: 10000
      });
    }
    
    if (changedKeys.includes('pollInterval')) {
      this.log(`Poll interval changed to ${newSettings.pollInterval}s`);
      this.pollInterval = newSettings.pollInterval * 1000;
      this.failedPollCount = 0; // Reset failure count on settings change
      
      // Restart polling with new interval
      this.startPolling();
    }
  }
}

module.exports = WLEDDevice; 