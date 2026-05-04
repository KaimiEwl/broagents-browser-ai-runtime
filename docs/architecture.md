# Architecture

## Purpose

A local control center for coordinating AI browser tabs as role-based agents.

## Main flow

`	ext
Browser tab -> Chrome extension -> local WebSocket server -> dashboard -> operator actions -> browser agents
`

## Design notes

The runtime is designed to be portable: a project can include BROAGENTS and launch the same browser-agent workflow locally.

## Portfolio note

This repository is packaged for review. Some runtime integrations require local credentials or external services and are represented with .env.example instead of real secrets.
