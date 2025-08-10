import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertMessageSchema, insertGoalSchema, insertDecisionSchema } from "@shared/schema";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "default_key"
});

const DEFAULT_USER_ID = "demo-user";

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Get conversation messages
  app.get("/api/conversations/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getMessages(conversationId);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  // Send message and get AI response
  app.post("/api/chat", async (req, res) => {
    const { message, conversationId } = req.body;
    
    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    let currentConversationId = conversationId;
    
    try {
      
      // Create new conversation if none exists
      if (!currentConversationId) {
        const conversation = await storage.createConversation({
          userId: DEFAULT_USER_ID,
          title: message.substring(0, 50) + "..."
        });
        currentConversationId = conversation.id;
      }

      // Save user message
      await storage.createMessage({
        conversationId: currentConversationId,
        role: "user",
        content: message
      });

      // Get conversation history for context
      const messages = await storage.getMessages(currentConversationId);
      const conversationHistory = messages.map(msg => ({
        role: msg.role as "user" | "assistant",
        content: msg.content
      }));

      // Generate AI response using Gemini
      const systemPrompt = `You are a cyberpunk-themed AI life navigator and decision support system. You provide guidance on life decisions, daily planning, goal setting, and personal optimization with a futuristic, tech-savvy perspective. 

Your responses should be:
- Analytical and data-driven
- Supportive but direct
- Focus on actionable advice
- Include references to optimization, efficiency, and systematic thinking
- Maintain a slightly futuristic tone without being overly dramatic

When users ask for decision support, create structured analysis including pros/cons, risk assessment, and recommendations. For planning requests, provide organized, systematic approaches.`;

      const response = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        config: {
          systemInstruction: systemPrompt,
        },
        contents: [
          ...conversationHistory.map(msg => ({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }]
          }))
        ],
      });

      const aiMessage = response.text || "I'm unable to process that request right now.";

      // Save AI response
      await storage.createMessage({
        conversationId: currentConversationId,
        role: "assistant", 
        content: aiMessage
      });

      res.json({
        message: aiMessage,
        conversationId: currentConversationId
      });

    } catch (error: any) {
      console.error("Chat error:", error);
      
      // Provide helpful error message if it's a Gemini API issue
      if (error.status === 429 || error.code === 'insufficient_quota' || error.message?.includes('quota') || error.message?.includes('rate limit')) {
        const fallbackMessage = "⚠️ AI service temporarily unavailable. The navigator system is experiencing high demand. Please try again in a moment.\n\nIn the meantime, I can still help you organize your thoughts and plans through this interface.";
        
        // Save user message anyway
        await storage.createMessage({
          conversationId: currentConversationId,
          role: "assistant",
          content: fallbackMessage
        });
        
        return res.json({
          message: fallbackMessage,
          conversationId: currentConversationId
        });
      }
      
      res.status(500).json({ message: "Failed to process chat message" });
    }
  });

  // Get user goals
  app.get("/api/goals", async (req, res) => {
    try {
      const goals = await storage.getGoals(DEFAULT_USER_ID);
      res.json(goals);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch goals" });
    }
  });

  // Create new goal
  app.post("/api/goals", async (req, res) => {
    try {
      const goalData = insertGoalSchema.parse({
        ...req.body,
        userId: DEFAULT_USER_ID
      });
      
      const goal = await storage.createGoal(goalData);
      res.json(goal);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid goal data", errors: error.errors });
      }
      res.status(500).json({ message: "Failed to create goal" });
    }
  });

  // Update goal progress
  app.patch("/api/goals/:goalId/progress", async (req, res) => {
    try {
      const { goalId } = req.params;
      const { progress } = req.body;
      
      if (typeof progress !== "number" || progress < 0 || progress > 100) {
        return res.status(400).json({ message: "Progress must be a number between 0 and 100" });
      }
      
      const goal = await storage.updateGoalProgress(goalId, progress);
      if (!goal) {
        return res.status(404).json({ message: "Goal not found" });
      }
      
      res.json(goal);
    } catch (error) {
      res.status(500).json({ message: "Failed to update goal progress" });
    }
  });

  // Generate decision analysis
  app.post("/api/decisions/analyze", async (req, res) => {
    try {
      const decisionData = insertDecisionSchema.parse({
        ...req.body,
        userId: DEFAULT_USER_ID
      });

      // Generate AI analysis using Gemini
      const systemPrompt = `You are a cyberpunk AI decision analyst. Create a comprehensive decision analysis in JSON format with the following structure:
      {
        "summary": "Brief analysis summary",
        "factors": [
          {"name": "Factor name", "optionAScore": 1-10, "optionBScore": 1-10, "weight": 1-10, "reasoning": "explanation"}
        ],
        "riskAssessment": {
          "optionA": {"level": "Low|Medium|High", "description": "risk description"},
          "optionB": {"level": "Low|Medium|High", "description": "risk description"}
        },
        "recommendation": "Which option to choose and why",
        "confidence": 1-10
      }`;

      const prompt = `${systemPrompt}
      
      Analyze: "${decisionData.context}"
      Option A: "${decisionData.optionA}"
      Option B: "${decisionData.optionB}"`;

      const response = await genAI.models.generateContent({
        model: "gemini-2.5-pro",
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              factors: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    optionAScore: { type: "number" },
                    optionBScore: { type: "number" },
                    weight: { type: "number" },
                    reasoning: { type: "string" }
                  },
                  required: ["name", "optionAScore", "optionBScore", "weight", "reasoning"]
                }
              },
              riskAssessment: {
                type: "object",
                properties: {
                  optionA: {
                    type: "object",
                    properties: {
                      level: { type: "string" },
                      description: { type: "string" }
                    },
                    required: ["level", "description"]
                  },
                  optionB: {
                    type: "object",
                    properties: {
                      level: { type: "string" },
                      description: { type: "string" }
                    },
                    required: ["level", "description"]
                  }
                },
                required: ["optionA", "optionB"]
              },
              recommendation: { type: "string" },
              confidence: { type: "number" }
            },
            required: ["summary", "factors", "riskAssessment", "recommendation", "confidence"]
          }
        },
        contents: prompt
      });

      const analysis = JSON.parse(response.text || "{}");
      
      // Save decision with analysis
      const decision = await storage.createDecision({
        ...decisionData,
        analysis
      });

      res.json(decision);
    } catch (error: any) {
      console.error("Decision analysis error:", error);
      
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid decision data", errors: error.errors });
      }
      
      // Handle API quota/rate limit errors
      if (error.status === 429 || error.code === 'insufficient_quota' || error.message?.includes('quota') || error.message?.includes('rate limit')) {
        const fallbackAnalysis = {
          summary: "AI analysis temporarily unavailable due to high system demand. Please try again shortly.",
          factors: [
            {
              name: "Cost",
              optionAScore: 5,
              optionBScore: 5,
              weight: 8,
              reasoning: "Consider financial implications of both options"
            },
            {
              name: "Time Investment",
              optionAScore: 5,
              optionBScore: 5,
              weight: 7,
              reasoning: "Evaluate time requirements for each choice"
            }
          ],
          riskAssessment: {
            optionA: { level: "Medium", description: "Manual analysis recommended" },
            optionB: { level: "Medium", description: "Manual analysis recommended" }
          },
          recommendation: "AI analysis is currently unavailable. Consider creating a pros/cons list and consulting with trusted advisors.",
          confidence: 3
        };
        
        const decision = await storage.createDecision({
          ...decisionData,
          analysis: fallbackAnalysis
        });
        
        return res.json(decision);
      }
      
      res.status(500).json({ message: "Failed to analyze decision" });
    }
  });

  // Get life metrics
  app.get("/api/metrics", async (req, res) => {
    try {
      const metrics = await storage.getLatestLifeMetrics(DEFAULT_USER_ID);
      
      // If no metrics exist, create default ones
      if (!metrics) {
        const defaultMetrics = await storage.createLifeMetrics({
          userId: DEFAULT_USER_ID,
          productivity: 75,
          decisionQuality: 68,
          stressLevel: 35,
          date: new Date()
        });
        return res.json(defaultMetrics);
      }
      
      res.json(metrics);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch metrics" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
