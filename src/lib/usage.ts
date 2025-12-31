import { RateLimiterPrisma } from "rate-limiter-flexible";
import {prisma} from "@/lib/db";
import { auth } from "@clerk/nextjs/server";

const FREE_POINTS = 5;
const PRO_POINTS = 75;
const DURATION = 30*24*60*60; //30 days
const GENERATION_COST = 1

export async function getUsageTracker() {
    const { has } = await auth();
    const hasProAccess = has({ plan: "pro"});

    const usageTracker = new RateLimiterPrisma({
        storeClient: prisma,
        tableName: "Usage",
        points: hasProAccess ?  PRO_POINTS : FREE_POINTS,
        duration: DURATION,
    });

    return usageTracker;
};

export async function consumeCredits() {
    const { userId } = await auth();

    if(!userId) {
        throw new Error("User not authenticated");
    }

    const usageTracker = await getUsageTracker();
    const result = await usageTracker.consume(userId, GENERATION_COST);

    return result;
};

export async function getUsageStatus() {
     const { userId } = await auth();

    if(!userId) {
        throw new Error("User not authenticated");
    }

    const usageTracker = await getUsageTracker();

    //const result = await usageTracker.get(userId);
   //return result

try {
        const result = await usageTracker.get(userId);
        
        if (!result) {
            // User hasn't used any credits yet
            return {
                remainingPoints: FREE_POINTS,
                msBeforeNext: 0,
                consumedPoints: 0,
                isFirstInDuration: true,
            };
        }

        return {
            remainingPoints: result.remainingPoints,
            msBeforeNext: result.msBeforeNext,
            consumedPoints: result.consumedPoints,
            isFirstInDuration: result.isFirstInDuration,
        };
    } catch (error) {
        // If user record doesn't exist yet, return full points
        return {
            remainingPoints: FREE_POINTS,
            msBeforeNext: 0,
            consumedPoints: 0,
            isFirstInDuration: true,
        };
    }
}