package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	nolag "github.com/NoLagApp/nolag-go"
)

var (
	token  = flag.String("token", "", "NoLag actor token (required)")
	broker = flag.String("broker", "ws://localhost:8080/ws", "NoLag broker URL")
)

func main() {
	flag.Parse()

	if *token == "" {
		fmt.Println("Error: -token is required")
		os.Exit(1)
	}

	log.Println("Creating NoLag client...")
	log.Println("Broker:", *broker)

	client := nolag.New(*token, nolag.Options{
		URL:               *broker,
		Reconnect:         false, // Disable reconnect for testing
		HeartbeatInterval: 30 * time.Second,
		Debug:             true,
	})

	client.On("connected", func(args ...any) {
		log.Println("EVENT: Connected!")
	})

	client.On("disconnected", func(args ...any) {
		log.Println("EVENT: Disconnected!")
	})

	client.On("error", func(args ...any) {
		log.Println("EVENT: Error:", args)
	})

	log.Println("Connecting...")
	if err := client.Connect(); err != nil {
		log.Fatal("Connect failed:", err)
	}

	log.Println("Connected successfully!")
	log.Println("Actor ID:", client.ActorID())

	// Try subscribing to a topic
	room := client.SetApp("remote-terminal").SetRoom("my-pc")
	log.Println("Subscribing to status topic...")
	err := room.Subscribe("status", func(data any, meta nolag.MessageMeta) {
		log.Println("Received message:", data)
	})
	if err != nil {
		log.Println("Subscribe error:", err)
	} else {
		log.Println("Subscribed successfully!")
	}

	log.Println("Press Ctrl+C to exit...")

	// Wait for signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down...")
	client.Close()
}
