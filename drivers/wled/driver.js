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
      const resultIds = Object.keys(currentResults);
      this.log('Initial discovery results:', resultIds.length);
      
      if (resultIds.length > 0) {
        // Log detailed information about each discovery result
        for (const id of resultIds) {
          const result = currentResults[id];
          this.log(`Discovery result: ID=${id}, Address=${result.address}, Name=${result.name || 'unnamed'}`);
          this.onDiscoveryResult(result);
        }
      } else {
        this.log('No initial discovery results found');
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
    const id = discoveryResult.id;
    this.log(`Discovery result received: ID=${id}, Address=${discoveryResult.address || 'unknown'}`);
    
    if (!discoveryResult.address) {
      this.log('Skipping discovery result without address');
      return;
    }
    
    // Check if this is a new discovery or an update
    const isNew = !this.discoveryResults[id];
    this.discoveryResults[id] = discoveryResult;
    
    if (isNew) {
      this.log(`New WLED device discovered: ${discoveryResult.address}`);
    } else {
      this.log(`Updated discovery for WLED device: ${discoveryResult.address}`);
    }
    
    // Log the current count of discovered devices
    this.log(`Total discovered devices: ${Object.keys(this.discoveryResults).length}`);
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
    let selectedDevice = null;

    // View navigation handler
    session.setHandler('showView', async (view) => {
      activeView = view;
      this.log(`Pairing: navigated to view ${view}`);
      
      // Reset manual device on start view
      if (view === 'start') {
        manualDevice = null;
        selectedDevice = null;
      }
    });

    // Log handler for debugging
    session.setHandler('log', async (message) => {
      this.log(`WebView: ${message}`);
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

    // New handler to store a selected device from discover_devices view
    session.setHandler('selected_device', async (device) => {
      this.log('Device selected for pairing:', device.name, device.data.id);
      selectedDevice = device;
      return true;
    });

    // New handler to get the selected device on the add_device page
    session.setHandler('get_selected_device', async () => {
      if (activeView === 'manual_entry' && manualDevice) {
        this.log('Returning manual device for pairing');
        return manualDevice;
      }
      
      if (selectedDevice) {
        this.log('Returning selected device for pairing');
        return selectedDevice;
      }
      
      this.error('No device selected for pairing');
      return null;
    });

    // Handler for discover_devices view to list discovered devices 
    session.setHandler('list_devices', async () => {
      // Get current discovered devices
      const discoveryResults = Object.values(this.discoveryResults || {});
      this.log(`Discovered ${discoveryResults.length} devices for pairing`);
      
      const devices = [];
      
      // Process each discovery result
      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          try {
            this.log(`Processing discovery result for ${discoveryResult.address}`);
            const deviceInfo = await this.getDeviceInfo(discoveryResult.address);
            this.log(`Found device: ${deviceInfo.name} at ${deviceInfo.settings.address}`);
            devices.push(deviceInfo);
          } catch (error) {
            // Skip devices with errors
            this.error(`Error getting info for ${discoveryResult.address}: ${error.message}`);
          }
        }
      }
      
      this.log(`Returning ${devices.length} devices for pairing`);
      return devices;
    });
  }
}

module.exports = WLEDDriver;