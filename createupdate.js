require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parser');
const Twilio = require('twilio');

const { log } = require('./helpers/logger');
const { confirmTargetAccount, confirmToProceed } = require('./helpers/utils');

const {
  ACCOUNT_SID,
  AUTH_TOKEN,
  OFFLINE_ACTIVITY_SID,
  TEMP_ACTIVITY_SID,
  TR_WORKSPACE_SID,
} = process.env;

const client = Twilio(ACCOUNT_SID, AUTH_TOKEN);

const workerDetailsFile = process.argv.slice(2)[0];
const workerSkillsFile = process.argv.slice(3)[0];

const workerSkills = {}; // Object to store worker skills loaded from CSV
let existingWorkers = []; // Array to store existing workers pulled from REST API
const workersToLoad = []; // Array to store workers loaded from CSV
const workersToCreate = []; // Array to store workers to create
const workersToUpdate = []; // Array to store workers to update

function isPrimitiveEqual(a, b) {
  // Considering anything falsy as equal
  return !a && !b ? true : a === b;
}

function escapeNonAlphaChars(stringToEscape, prefix = '_') {
  // This logic attempts to match the Flex UI native code that transforms the worker's
  // username (friendlyName) to the Voice Client ID it registers with
  const escaped = stringToEscape.replace(/[^A-Za-z0-9]/g, function(match) {
      const hex = match.charCodeAt(0).toString(16).toUpperCase();
      return prefix + (hex.length < 2 ? '0' + hex : hex);
  });
  return escaped;
}

function generateContactUri(friendlyName) {
  return `client:${escapeNonAlphaChars(friendlyName)}`;
}

async function getExistingWorkers() { //Go get existing Workers
  log.info('Fetching all existing workers from TaskRouter');
  existingWorkers = await client.taskrouter.workspaces(TR_WORKSPACE_SID)
    .workers
    .list({ pageSize: 1000 });
  log.info(`Workers fetched. Count: ${existingWorkers.length}`);
}

async function loadCSVs() { //Let's load the worker and skills CSVs
  // Use a promise to ensure function doesn't return before CSVs are loaded
  return new Promise((resolve, reject) => {
    log.info(`Loading worker details from ${workerDetailsFile}...`);
    fs.createReadStream(workerDetailsFile)
      .pipe(csv())
      .on('data', (data) => {
        workersToLoad.push(data);
      })
      .on('end', () => {
        log.info(`Worker details loaded. Count: ${workersToLoad.length}`);
        // Load worker skills from CSV (if provided)
        if (workerSkillsFile) {
          log.info(`Loading worker skills from ${workerSkillsFile}...`);
          fs.createReadStream(workerSkillsFile)
          .pipe(csv())
          .on('data', (data) => {
            if (!workerSkills[data.email]) {
              workerSkills[data.email] = {
                skills: {},
              };
            }
            Object.keys(data).forEach(skill => {
              if (skill !== 'email' && data[skill]) {
                if (data[skill] === 'x') {
                  workerSkills[data.email].skills[skill] = null; // Set skill with no level
                } else if (!isNaN(data[skill])) {
                  workerSkills[data.email].skills[skill] = parseInt(data[skill]); // Set skill with level
                }
              }
            });
          })
          .on('end', () => {
            log.info(`Worker skills loaded. Count: ${Object.keys(workerSkills).length}`);
            resolve();
          });  
        } else {
          log.info('No worker skills file provided');
          resolve();
        } 
      });
  });
}

async function processWorkerChanges() {
  const existingWorkerNames = existingWorkers.map(w => w.friendlyName);
  
  for (let i = 0; i < workersToLoad.length; i++) { //Build Array for Worker names to load
    const workerFriendlyName = workersToLoad[i].friendlyName;

    if (existingWorkerNames.indexOf(workerFriendlyName) === -1) { //Check for new Worker
      workersToCreate.push(workerFriendlyName);

    } else {
      workersToUpdate.push(workerFriendlyName);
    }
  }

  const confirmationMessage = ("List loaded, we have " + workersToCreate.length + " new Workers and " + workersToUpdate.length + " Workers to update");
  let isConfirmed = await confirmToProceed(confirmationMessage);
  if (!isConfirmed) {
    return;
  }
  //filterQueues(workersToUpdate, workersToCreate, workersToLoad, existingWorkers)
  await createWorkers(workersToCreate, workersToLoad);
  await updateWorkers(workersToUpdate, workersToLoad, existingWorkers);
}

async function createWorkers() {
  const filteredWorkers = workersToLoad.filter(w => workersToCreate.includes(w.friendlyName));

  for (let i = 0; i < filteredWorkers.length; i++) {
    const worker = filteredWorkers[i];

    const {
      agent_attribute_1,
      date_joined,
      date_left,
      email,
      friendlyName,
      full_name,
      location,
      manager,
      team_id,
      team_name,
      department_id,
      department_name,
      extension,
      configuredCallerId,
    } = worker;

    const dateJoined = isNaN(parseInt(date_joined))
      ? undefined
      : parseInt(date_joined);

    const dateLeft = isNaN(parseInt(date_left))
      ? undefined
      : parseInt(date_left);

    const workerAttributes = {
      agent_attribute_1,
      contact_uri: generateContactUri(friendlyName),
      date_joined: dateJoined,
      date_left: dateLeft,
      email,
      full_name,
      location,
      manager,
      team_id,
      team_name,
      department_id,
      department_name,
      extension,
      configuredCallerId,
      routing: {
        skills: [],
        levels: {}
      }
    };

    // Add skills to attributes if available
    const skills = workerSkills[worker.email]?.skills;
    if (skills) {
      workerAttributes.routing.skills = Object.keys(skills);
      workerAttributes.routing.levels = Object.fromEntries(
        Object.entries(skills).filter(([_, level]) => level !== null)
      );
    }

    try {
      await client.taskrouter.workspaces(TR_WORKSPACE_SID)
        .workers
        .create({
          friendlyName,
          attributes: JSON.stringify(workerAttributes)
        });
      log.info(`Created worker ${friendlyName} with attributes ${JSON.stringify(workerAttributes)}`);
    } catch (error) {
      switch (error.code) {
        case 20001:
          log.error(`${friendlyName} exists. ${JSON.stringify(error)}`);
          break;
        case 20429:
          log.error(`Throttling, too many requests. ${JSON.stringify(error)}`);
          break;
        default:
          log.error(JSON.stringify(error));
      }
    }
  }
}

async function updateWorkers() {
  const filteredWorkers = workersToLoad.filter(w => {
    if (!workersToUpdate.includes(w.friendlyName)) {
      return false;
    }
    const existingWorker = existingWorkers.find(ew => ew.friendlyName === w.friendlyName);
    const existingAttributes = JSON.parse(existingWorker.attributes);

    const dateJoined = isNaN(parseInt(w.date_joined))
      ? undefined
      : parseInt(w.date_joined);

    const dateLeft = isNaN(parseInt(w.date_left))
      ? undefined
      : parseInt(w.date_left);
    
    if (workerSkillsFile) {
      // Get the workers existing skills
      const existingSkills = existingAttributes.routing?.skills || [];
      const existingLevels = existingAttributes.routing?.levels || {};

      // Get the workers new skills
      const newSkills = workerSkills[w.email]?.skills;
      const newSkillKeys = newSkills ? Object.keys(newSkills) : [];
      const newLevels = newSkills ? Object.fromEntries(
        Object.entries(newSkills).filter(([_, level]) => level !== null)
      ) : {};

      // If the skills differ, the worker will be updated
      if (existingSkills.length !== newSkillKeys.length) {
        return true;
      }
      for (const skill of existingSkills) {
        if (!newSkillKeys.includes(skill)) {
          return true;
        }
        if (existingLevels[skill] !== newLevels[skill]) {
          return true;
        }
      }
    }

    // If any one of the CSV attributes differ from the matching worker attribute, the worker will be updated
    return (!isPrimitiveEqual(w.agent_attribute_1, existingAttributes.agent_attribute_1)
      || !isPrimitiveEqual(dateJoined, existingAttributes.date_joined)
      || !isPrimitiveEqual(dateLeft, existingAttributes.date_left)
      || !isPrimitiveEqual(w.email, existingAttributes.email)
      || !isPrimitiveEqual(w.full_name, existingAttributes.full_name)
      || !isPrimitiveEqual(w.location, existingAttributes.location)
      || !isPrimitiveEqual(w.manager, existingAttributes.manager)
      || !isPrimitiveEqual(w.team_id, existingAttributes.team_id)
      || !isPrimitiveEqual(w.team_name, existingAttributes.team_name)
      || !isPrimitiveEqual(w.department_id, existingAttributes.department_id)
      || !isPrimitiveEqual(w.department_name, existingAttributes.department_name)
      || !isPrimitiveEqual(w.extension, existingAttributes.extension)
      || !isPrimitiveEqual(w.configuredCallerId, existingAttributes.configuredCallerId)
    );
  });

  log.info(`Of the workers to update, there are ${filteredWorkers.length} with changed attributes`);

  if (filteredWorkers.length === 0) {
    log.info('No worker updates are required');
    return;
  }

  for (let i = 0; i < filteredWorkers.length; i++) {
    const worker = filteredWorkers[i];
    const {
      agent_attribute_1,
      date_joined,
      date_left,
      email,
      friendlyName,
      full_name,
      location,
      manager,
      team_id,
      team_name,
      department_id,
      department_name,
      extension,
      configuredCallerId,
    } = worker;

    const dateJoined = isNaN(parseInt(date_joined))
      ? ""
      : parseInt(date_joined);

    const dateLeft = isNaN(parseInt(date_left))
      ? ""
      : parseInt(date_left);
    
    const existingWorker = existingWorkers.find(w => w.friendlyName === friendlyName);
    const existingAttributes = JSON.parse(existingWorker.attributes);

    const updatedAttributes = {
      agent_attribute_1,
      date_joined: dateJoined,
      date_left: dateLeft,
      email,
      full_name,
      location,
      manager,
      team_id,
      team_name,
      department_id,
      department_name,
      extension,
      configuredCallerId,
    };

    const workerAttributes = {
      ...existingAttributes,
      routing: {
        ...existingAttributes.routing
      }
    };

    // Add skills to attributes if available
    if (workerSkillsFile) {
      workerAttributes.routing.skills = Object.keys(workerSkills[worker.email]?.skills || {});
      workerAttributes.routing.levels = Object.fromEntries(
          Object.entries(workerSkills[worker.email]?.skills || {}).filter(([_, level]) => level !== null)
        );
    }

    for (const key of Object.keys(updatedAttributes)) {
      if (updatedAttributes[key] !== undefined) {
        workerAttributes[key] = updatedAttributes[key]
      }
      if (workerAttributes[key] === "") {
        // Ensuring attributes aren't set with empty strings since this can
        // cause issues with some Flex TeamsView filter logic
        delete workerAttributes[key]
      }
    }

    try {
      await client.taskrouter.workspaces(TR_WORKSPACE_SID)
        .workers(existingWorker.sid)
        .update({
          attributes: JSON.stringify(workerAttributes)
        });
      log.info(`Updated worker ${friendlyName} with attributes ${JSON.stringify(workerAttributes)}`);
    } catch (error) {
      switch (error.code) {
        case 20001:
          log.error(`${friendlyName} exists. ${JSON.stringify(error)}`);
          break;
        case 20429:
          log.error(`Error updating ${friendlyName}. Throttling, too many requests. ${JSON.stringify(error)}`);
          break;
        default:
          log.error(`Error updating ${friendlyName}. ${JSON.stringify(error)}`);
      }
    }

    if (dateLeft) {
      try {
        // Assuming this is a worker that will not login to Flex again, and since an 
        // activity change is required for Flex Insights to receive the updated attributes,
        // performing that activity change here to ensure Flex Insights gets the updates
        await client.taskrouter.workspaces(TR_WORKSPACE_SID)
          .workers(existingWorker.sid)
          .update({
            activitySid: TEMP_ACTIVITY_SID
          });
        await client.taskrouter.workspaces(TR_WORKSPACE_SID)
          .workers(existingWorker.sid)
          .update({
            activitySid: OFFLINE_ACTIVITY_SID
          });
        log.info(`Flipped activity for terminated worker ${friendlyName}`);
      } catch (error) {
        switch (error.code) {
          case 20429:
            log.error(`Error flipping activity for terminated worker ${friendlyName}. Throttling, too many requests. ${JSON.stringify(error)}`);
            break;
          default:
            log.error(`Error flipping activity for terminated worker ${friendlyName}. ${JSON.stringify(error)}`);
        }
      } 
    }

  }
}

async function runScript() {
  let isConfirmed = await confirmTargetAccount(client);
  if (!isConfirmed) {
    return;
  }

  await getExistingWorkers();
  await loadCSVs();
  await processWorkerChanges();
}

// Starting script
runScript();
