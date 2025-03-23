'use strict';

const Homey = require('homey');
const { HttpClient } = require('../../lib/http-client');

class WLEDDevice extends Homey.Device {
  
  async onInit() {
    this.log('WLED Device initialized');
    
    // Get device settings
    this.settings = this.getSettings();
    this.address = this.settings.address;
    this.pollInterval = this.settings.pollInterval * 1000; // Convert to milliseconds
    
    // Initialize API client
    this.apiClient = new HttpClient(`http://${this.address}`);
    
    // Store device state
    this.state = {
      on: false,
      brightness: 0,
      hue: 0,
      saturation: 0,
      effect: 0,
      palette: 0
    };
    
    // Connection retry mechanism
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    
    // Register capability listeners
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerCapabilityListener('light_hue', this.onCapabilityLightHue.bind(this));
    this.registerCapabilityListener('light_saturation', this.onCapabilityLightSaturation.bind(this));
    this.registerCapabilityListener('wled_effect', this.onCapabilityEffect.bind(this));
    this.registerCapabilityListener('wled_palette', this.onCapabilityPalette.bind(this));
    
    // Start polling with resilience
    this.startPolling();
  }
  
  // Start polling for device state updates
  startPolling() {
    this.pollingInterval = setInterval(async () => {
      try {
        await this.updateDeviceState();
        
        // Handle availability state
        if (!this.getAvailable()) {
          this.setAvailable().catch(this.error);
        }
      } catch (error) {
        // Only set unavailable after 3 consecutive failures
        this.connectionAttempts = (this.connectionAttempts || 0) + 1;
        if (this.connectionAttempts > 3) {
          this.setUnavailable('Device is unreachable').catch(this.error);
        }
      }
    }, this.pollInterval);
  }
  
  // Fetch and update device state with retry logic
  async updateDeviceState() {
    try {
      // Use a longer timeout for potentially challenging WiFi conditions
      this.apiClient.timeout = 10000;
      
      const state = await this.apiClient.get('/json/state');
      
      // Update capability values
      this.setCapabilityValue('onoff', state.on).catch(this.error);
      
      // Only update dim if device is on to prevent unwanted 0 values
      if (state.on) {
        const brightness = state.bri / 255;
        this.setCapabilityValue('dim', brightness).catch(this.error);
      }
      
      // Update color values if available
      if (state.seg && state.seg[0] && state.seg[0].col) {
        const { h, s } = this.rgbToHsv(state.seg[0].col[0][0], state.seg[0].col[0][1], state.seg[0].col[0][2]);
        this.setCapabilityValue('light_hue', h).catch(this.error);
        this.setCapabilityValue('light_saturation', s).catch(this.error);
      }
      
      // Update effect and palette
      if (state.seg && state.seg[0]) {
        this.setCapabilityValue('wled_effect', state.seg[0].fx).catch(this.error);
        this.setCapabilityValue('wled_palette', state.seg[0].pal).catch(this.error);
      }
      
      // Store current state
      this.state = {
        on: state.on,
        brightness: state.bri,
        effect: state.seg?.[0]?.fx || 0,
        palette: state.seg?.[0]?.pal || 0
      };
      
      // Reset connection attempts counter on successful update
      if (this.connectionAttempts > 0) {
        this.connectionAttempts = 0;
        this.setAvailable().catch(this.error);
      }
      
    } catch (error) {
      this.error('Error fetching device state:', error);
      
      // Increment connection attempts
      this.connectionAttempts = (this.connectionAttempts || 0) + 1;
      
      // Set device as unavailable after multiple failures
      if (this.connectionAttempts >= 5) {
        this.setUnavailable('Cannot connect to device. May be on a different WiFi channel.').catch(this.error);
      }
      
      throw error;
    }
  }
  
  // Capability listeners
  async onCapabilityOnoff(value) {
    await this.apiClient.post('/json/state', { on: value });
    this.state.on = value;
  }
  
  async onCapabilityDim(value) {
    const brightness = Math.round(value * 255);
    await this.apiClient.post('/json/state', { bri: brightness });
    this.state.brightness = brightness;
  }
  
  async onCapabilityLightHue(value) {
    await this.updateColor(value, this.getCapabilityValue('light_saturation'));
  }
  
  async onCapabilityLightSaturation(value) {
    await this.updateColor(this.getCapabilityValue('light_hue'), value);
  }
  
  async onCapabilityEffect(value) {
    await this.apiClient.post('/json/state', { 
      seg: [{ fx: value }] 
    });
    this.state.effect = value;
  }
  
  async onCapabilityPalette(value) {
    await this.apiClient.post('/json/state', { 
      seg: [{ pal: value }] 
    });
    this.state.palette = value;
  }
  
  // Update the color of the WLED device
  async updateColor(hue, saturation) {
    const rgb = this.hsvToRgb(hue, saturation, 1.0);
    await this.apiClient.post('/json/state', {
      seg: [{
        col: [[rgb.r, rgb.g, rgb.b]]
      }]
    });
  }
  
  // Convert HSV to RGB
  hsvToRgb(h, s, v) {
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
  
  // Convert RGB to HSV
  rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s;
    const v = max;
    
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
  
  // This matches the discovery result with the device
  onDiscoveryResult(discoveryResult) {
    // Return true if this is your device
    const id = this.getData().id;
    return id === `wled-${discoveryResult.id.replace(/\./g, '-')}`;
  }
  
  // This is called when the user adds or updates a device
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('address')) {
      this.address = newSettings.address;
      this.apiClient = new HttpClient(`http://${this.address}`);
    }
    
    if (changedKeys.includes('pollInterval')) {
      this.pollInterval = newSettings.pollInterval * 1000;
      clearInterval(this.pollingInterval);
      this.startPolling();
    }
  }
  
  // Clean up on device removal
  async onUninit() {
    clearInterval(this.pollingInterval);
    this.log('WLED device removed');
  }
  
  // Add a method to verify connection
  async verifyConnection() {
    try {
      const info = await this.apiClient.get('/json/info');
      if (!info || !info.brand || info.brand.toLowerCase() !== 'wled') {
        throw new Error('Device does not appear to be a WLED device');
      }
      this.log('Connection verified to WLED device:', info.name);
      return true;
    } catch (error) {
      this.error('Connection verification failed:', error);
      throw error;
    }
  }
}

module.exports = WLEDDevice; 