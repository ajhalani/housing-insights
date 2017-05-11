"use strict";

/* 
 * MODEL **********************************
 */

var model = {  // TODO (?) change to a module similar to State and Subscribe so that dataCollection can only be accessed
               // through functions that the module returns to the handlers
    dataCollection: {
  
    },
    manifest: { // for purpose of example, this is hard coded in but could instead reference actual data manifest
        patterns: [
            {
                path: 'http://hiapidemo.us-east-1.elasticbeanstalk.com/api/',
                members: ['raw','crime','building_permits'],
                extension: null,
                type:'json'
            },
            {
                path: 'data/',
                members: ['ward','tract','neighborhood','zip', 'zillow'],
                extension: '.geojson',
                type:'json'
            }
        ]
    }
    
};

/* STATE ********************************
 *
 * State module keeps the state object private; only access is through module-scoped functions with closure over state. We have access
 * to those functions, and thus to state, by returning them to controller.controlState.
 */

function StateModule() {
        
    var state = {};

    function logState(){
        console.log(state);
    }

    function getState(){
        return state;
    }

    function setState(key,value) { // making all state properties arrays so that previous value is held on to
                                   // current state to be accessed as state[key][0].
        if ( state[key] === undefined ) {
            state[key] = [value];
            PubSub.publish(key, value);
            console.log('STATE CHANGE', key, value);
        } else if ( state[key][0] !== value ) { // only for when `value` is a string or number. doesn't seem
                                                // to cause an issue when value is an object, but it does duplicate
                                                // the state. i.e. key[0] and key[1] will be equivalent. avoid that
                                                // with logic before making the setState call.
            state[key].unshift(value);
            PubSub.publish(key, value);
            console.log('STATE CHANGE', key, value);
            if ( state[key].length > 2 ) {
                state[key].length = 2;
            }
        }
        
    }
    function clearState(key) {
        delete state[key];
         PubSub.publish('clearState', key);
         console.log('CLEAR STATE', key);
    }
    return {
        logState: logState,
        getState: getState,
        setState: setState,
        clearState: clearState
    }
}

/*
 * Subscriptions module for setting, canceling, and logging all PubSub subscriptions. Automatically creates token for each unique
 * plus function (string) combination so that we don't have to remember them and so that duplicate topic-function pairs
 * cannot be made.
 */

 function SubscribeModule() {
    var subscriptions = {};

    function logSubs() {
        console.log(subscriptions);
    }

    function createToken(topic, fnRef){
        var functionHash = 'f' + fnRef.toString().hashCode();
        var str = topic + fnRef;
        var token = 'sub' + str.hashCode();
        return {
            token: token,
            fn: functionHash
        }
    }

    function setSubs(subsArray) { // subsArray is array of topic/function pair arrays
        subsArray.forEach(function(pair){
            var topic = pair[0],
                fnRef = pair[1],
                tokenObj = createToken(topic,fnRef);
            
            if ( subscriptions[tokenObj.fn] === undefined ) {
                subscriptions[tokenObj.fn] = {};
            }
            if ( subscriptions[tokenObj['fn']][topic] === undefined ) {
                subscriptions[tokenObj['fn']][topic] = PubSub.subscribe(topic,fnRef);  
            } else {
                throw 'Subscription token is already in use.';
            }
        });
    }

    function cancelSub(topic,fnRef) { // for canceling single subscription
        var tokenObj = createToken(topic,fnRef);
        if ( subscriptions[tokenObj.fn] !== undefined && subscriptions[tokenObj['fn']][topic] !== undefined ) {
            PubSub.unsubscribe( subscriptions[tokenObj['fn']][topic] );
            delete subscriptions[tokenObj['fn']][topic];
            if ( Object.keys(subscriptions[tokenObj['fn']]).length === 0 ) {
                delete subscriptions[tokenObj['fn']];
            }
        } else {
            throw 'Subscription does not exist.';
        }
    }

    function cancelFunction(fnRef) {
        var tokenObj = createToken('',fnRef);
        PubSub.unsubscribe(fnRef);
        delete subscriptions[tokenObj['fn']];
    }

    return {
        logSubs:logSubs,
        setSubs:setSubs,
        cancelSub:cancelSub,
        cancelFunction: cancelFunction
    };

 }

 
/*
 * CONTROLLER ******************************
 */

var controller = {
    controlState: StateModule(),
    controlSubs: SubscribeModule(),
    init: function(){        
        mapView.init();        
    },                                  
    getData: function(dataRequest){
        var paramsUnderscore = dataRequest.params ? '_' + dataRequest.params.join('_') : '';
        if (model.dataCollection[dataRequest.name + paramsUnderscore] === undefined) { // if data not in collection
            var meta = this.dataMeta(dataRequest.name);
            var paramsSlash = dataRequest.params ? '/' + dataRequest.params.join('/') : '';
            var extension = meta.extension || '';
            d3.json(meta.path + dataRequest.name + paramsSlash + extension, function(error, data){
                if ( error ) { console.log(error); }
                model.dataCollection[dataRequest.name + paramsUnderscore] = data;
                setState('dataLoaded.' + dataRequest.name + paramsUnderscore, true );
                if ( dataRequest.callback !== undefined ) { // if callback has been passed in 
                    dataRequest.callback(data);
                }                               
            });
               
        } else {
            // TODO publish that data is available
            if ( dataRequest.callback !== undefined ) { // if callback has been passed in 
                dataRequest.callback(model.dataCollection[dataRequest.name + paramsUnderscore]);
            }              
        }
    },
    dataMeta: function(dataName) {
        var patternMatch = model.manifest.patterns.find(function(pattern){
            return pattern.members.indexOf(dataName) !== -1;
        });
        return {
            path: patternMatch.path,
            type: patternMatch.type,
            extension: patternMatch.extension
        };
    },
    appendPartial: function(partial, elemID){
        d3.html('partials/' + partial + '.html', function(fragment){
            document.getElementById(elemID).appendChild(fragment);            
        });
    },
    joinToGeoJSON: function(overlay,grouping,activeLayer){
        model.dataCollection[activeLayer].features.forEach(function(feature){
            var zone = feature.properties.NAME;
            console.log(zone);
            var dataKey = overlay + '_all_' + grouping;
            feature.properties[overlay] = model.dataCollection[dataKey].items.find(function(obj){
                return obj.group === zone;
            }).count;
        });
        console.log(overlay,grouping,activeLayer);
        setState('joinedToGeo.' +  overlay + '-' + activeLayer, {overlay:overlay, grouping:grouping, activeLayer:activeLayer});
        // e.g. joinedToGeo.crime-neighborhood, {overlay:'crime',grouping:'neighborhood_cluster',activeLayer:'neighborhood'}
    },
    convertToGeoJSON: function(data){ // thanks, Rich !!! JO. takes non-geoJSON data with latititude and longitude fields
                                      // and returns geoJSON with the original data in the properties field
        console.log(data);
        var features = data.items.map(function(element){ 
          return {
            'type': 'Feature',
            'geometry': {
              'type': 'Point',
              'coordinates': [+element.longitude, +element.latitude]
            },
            'properties': element        
          }
        });
        console.log(features);
        return {
          'type': 'FeatureCollection',
          'features': features
        }
    }
}

/* Aliases */

var setState = controller.controlState.setState,
    getState = controller.controlState.getState,
    logState = controller.controlState.logState,
    clearState = controller.controlState.clearState;

var setSubs = controller.controlSubs.setSubs,
    logSubs = controller.controlSubs.logSubs,
    cancelSub = controller.controlSubs.cancelSub,
    cancelFunction = controller.controlSubs.cancelFunction;

/*
 * POLYFILLS AND HELPERS ***********************
 */

 // HELPER array.move()

 Array.prototype.move = function (old_index, new_index) { // HT http://stackoverflow.com/questions/5306680/move-an-array-element-from-one-array-position-to-another
                                                          // native JS for moving around array items
                                                          // used e.g. in pie-chart.js to always move the all-zone option to the top 
    while (old_index < 0) {
        old_index += this.length;
    }
    while (new_index < 0) {
        new_index += this.length;
    }
    if (new_index >= this.length) {
        var k = new_index - this.length;
        while ((k--) + 1) {
            this.push(undefined);
        }
    }
    this.splice(new_index, 0, this.splice(old_index, 1)[0]);
    return this; // for testing purposes
};

// HELPER String.hashCode()

String.prototype.hashCode = function() {
  var hash = 0, i, chr, len;
  if (this.length === 0) return hash;
  for (i = 0, len = this.length; i < len; i++) {
    chr   = this.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

// HELPER String.cleanString()

String.prototype.cleanString = function() { // lowercase and remove punctuation and replace spaces with hyphens; delete punctuation
    return this.replace(/[ \\\/]/g,'-').replace(/['"”’“‘,\.!\?;\(\)&]/g,'').toLowerCase();
};

// Polyfill for Array.findIndex()

// https://tc39.github.io/ecma262/#sec-array.prototype.findIndex
if (!Array.prototype.findIndex) {
  Object.defineProperty(Array.prototype, 'findIndex', {
    value: function(predicate) {
     // 1. Let O be ? ToObject(this value).
      if (this == null) {
        throw new TypeError('"this" is null or not defined');
      }

      var o = Object(this);

      // 2. Let len be ? ToLength(? Get(O, "length")).
      var len = o.length >>> 0;

      // 3. If IsCallable(predicate) is false, throw a TypeError exception.
      if (typeof predicate !== 'function') {
        throw new TypeError('predicate must be a function');
      }

      // 4. If thisArg was supplied, let T be thisArg; else let T be undefined.
      var thisArg = arguments[1];

      // 5. Let k be 0.
      var k = 0;

      // 6. Repeat, while k < len
      while (k < len) {
        // a. Let Pk be ! ToString(k).
        // b. Let kValue be ? Get(O, Pk).
        // c. Let testResult be ToBoolean(? Call(predicate, T, « kValue, k, O »)).
        // d. If testResult is true, return k.
        var kValue = o[k];
        if (predicate.call(thisArg, kValue, k, o)) {
          return k;
        }
        // e. Increase k by 1.
        k++;
      }

      // 7. Return -1.
      return -1;
    }
  });
}

/* Go! */

controller.init(); 