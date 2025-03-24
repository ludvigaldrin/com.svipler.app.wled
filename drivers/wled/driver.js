'use strict';

const Homey = require('homey');
const axios = require('axios');

class WLEDDriver extends Homey.Driver {

  async onInit() {
    this.log('WLED Driver initialized');

    // Initialize discovery results storage
    this.discoveryResults = {};

    // Get the discovery strategy
    try {
      this.discoveryStrategy = this.getDiscoveryStrategy();

      // Listen for new discovery results
      this.discoveryStrategy.on('result', this.onDiscoveryResult.bind(this));

      // Process existing discovery results
      const currentResults = this.discoveryStrategy.getDiscoveryResults();
      this.log('Initial discovery results:', Object.keys(currentResults).length);
      for (const discoveryResult of Object.values(currentResults)) {
        this.onDiscoveryResult(discoveryResult);
      }
    } catch (error) {
      this.error('Discovery strategy error:', error);
    }

    this.homey.on('unload', () => {
      this.log('App is unloading, cleaning up discovery listeners');
    });
  }

  // Handle device discovery
  onDiscoveryResult(discoveryResult) {
    // Store results for pairing
    this.discoveryResults[discoveryResult.id] = discoveryResult;
  }

  // Called when a discovery result is added
  onDiscoveryAvailable(discoveryResult) {
    // Store discovery result
  }

  // Called when a discovery result address changes
  onDiscoveryAddressChanged(discoveryResult) {
    const id = discoveryResult.id;
    this.discoveryResults[id] = discoveryResult;
  }

  // Called when a discovery result's last seen timestamp changes
  onDiscoveryLastSeenChanged(discoveryResult) {
    // Update timestamp
  }
  
  // Helper method to get device info from API
  async getDeviceInfo(ip) {
    try {
      // Create HTTP client for this IP
      const apiClient = axios.create({
        baseURL: `http://${ip}`,
        timeout: 5000
      });
      
      // Get device info from WLED API
      const response = await apiClient.get('/json/info');
      const info = response.data;
      
      // Extract useful information from the API response
      
      // Use the custom name if it exists, or generate a friendly name based on host/mac
      let deviceName = 'WLED';
      if (info.name && info.name !== 'WLED') {
        // Use custom name if it's been changed from default
        deviceName = info.name;
      } else if (info.host) {
        // Use hostname if available
        deviceName = info.host;
      } else if (info.mac) {
        // Use a friendly name based on MAC address
        const shortMac = info.mac.substring(info.mac.length - 6);
        deviceName = `WLED-${shortMac}`;
      }
      
      // Get MAC address for a reliable ID
      const mac = info.mac ? info.mac.replace(/:/g, '') : '';
      
      // Create a unique ID - use MAC if available, otherwise fallback to IP-based ID
      const deviceId = mac ? `wled-${mac.toLowerCase()}` : `wled-${ip.replace(/\./g, '-')}`;
      
      // Create the device data
      const deviceData = {
        name: deviceName,
        data: {
          id: deviceId
        },
        settings: {
          address: ip,     // Keep original 'address' property for backwards compatibility
          ip: ip,          // Add 'ip' property for new code
          pollInterval: 5, // Keep original 'pollInterval' property
          polling_interval: 5000, // Add new property with value in milliseconds
          // Store additional info from the API for reference
          version: info.ver || '',
          fxcount: info.fxcount || 0,
          palcount: info.palcount || 0,
          ledCount: info.leds?.count || 0
        }
      };
      
      return deviceData;
    } catch (error) {
      this.error(`Error getting device info: ${error.message}`);
      throw new Error(`Could not connect to WLED device: ${error.message}`);
    }
  }

  async onPair(session) {
    // Track view state
    let activeView = '';
    let manualDevice = null;

    // View navigation handler
    session.setHandler('showView', async (view) => {
      activeView = view;
      
      // Reset manual device on start view
      if (view === 'start') {
        manualDevice = null;
      }
    });

    // Manual entry handler
    session.setHandler('manual_entry', async (data) => {
      try {
        const ip = data.ip;
        
        // Get device info
        const deviceInfo = await this.getDeviceInfo(ip);
        manualDevice = deviceInfo;
        
        return deviceInfo;
      } catch (error) {
        return Promise.reject(new Error(`Could not connect to WLED device: ${error.message}`));
      }
    });

    // List discovered devices
    session.setHandler('list_devices', async () => {
      // Get current discovered devices
      const discoveryResults = Object.values(this.discoveryResults || {});
      
      const devices = [];
      
      // Process each discovery result
      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          try {
            const deviceInfo = await this.getDeviceInfo(discoveryResult.address);
            devices.push(deviceInfo);
          } catch (error) {
            // Skip devices with errors
            this.error(`Error getting info for ${discoveryResult.address}: ${error.message}`);
          }
        }
      }
      
      return devices;
    });

    // Device creation handler
    session.setHandler('createDevice', async (device) => {
      // Only return the manual device if we have one and we're in manual entry
      if (activeView === 'manual_entry' && manualDevice) {
        return manualDevice;
      }
      
      // Return the selected device for discovery if we're in discovery view
      if (activeView === 'list_devices' && device && device.data && device.data.id) {
        return device;
      }
      
      // For any other case, return the device parameter
      return device;
    });
  }
}

module.exports = WLEDDriver;